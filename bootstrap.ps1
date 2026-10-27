<#
.SYNOPSIS
Sets up Windows for the dotfiles and runs the playbook in WSL.

.DESCRIPTION
Applies .config/configuration.winget, installs the WSL distribution, opens it once to create the Linux user,
and runs bootstrap.sh in it. Each step is skipped when it is already done, so run the script again after the
restart that enabling Virtual Machine Platform requires. Run it from a normal PowerShell; winget asks for
elevation once for the resources that need it.

.EXAMPLE
irm https://raw.githubusercontent.com/yosh-matsuda/dotfiles/main/bootstrap.ps1 | iex

.EXAMPLE
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/yosh-matsuda/dotfiles/main/bootstrap.ps1))) -Distro Ubuntu-24.04
#>
[CmdletBinding()]
param(
    # A name from `wsl --list --online`
    [string]$Distro = 'Ubuntu-26.04',
    [string]$Branch = 'main'
)

# Run through `irm | iex`, the script shares the caller's scope, so everything stays inside a function
# and nothing calls exit, which would close the caller's window.
function Invoke-DotfilesBootstrap {
    param([string]$Distro, [string]$Branch, [string]$ScriptRoot)

    $ErrorActionPreference = 'Stop'
    $rawBase = "https://raw.githubusercontent.com/yosh-matsuda/dotfiles/$Branch"

    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw 'winget was not found. Install or update App Installer from Microsoft Store, then run this script again.'
    }

    # A new Windows ships a stub App Installer whose winget configure fails with 0x8A150069
    # (APPINSTALLER_CLI_ERROR_PACKAGE_IS_STUB). --enable updates it to the full package from Microsoft Store,
    # and only reports that the features are enabled when they already are. It rejects --disable-interactivity.
    Write-Host 'Enabling winget configure'
    winget.exe configure --enable
    if ($LASTEXITCODE -ne 0) {
        throw "winget configure --enable failed with exit code $LASTEXITCODE. It needs access to Microsoft Store; update App Installer from Microsoft Store, then run this script again."
    }

    $configuration = if ($ScriptRoot) { Join-Path $ScriptRoot '.config\configuration.winget' }
    if (-not ($configuration -and (Test-Path -LiteralPath $configuration))) {
        $configuration = Join-Path $env:TEMP 'dotfiles-configuration.winget'
        Invoke-WebRequest -UseBasicParsing -Uri "$rawBase/.config/configuration.winget" -OutFile $configuration
    }
    Write-Host "Applying $configuration"
    winget.exe configure --file $configuration --accept-configuration-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "winget configure failed with exit code $LASTEXITCODE. Fix the failed units and run this script again."
    }

    $distros = @(wsl.exe --list --quiet 2>$null | ForEach-Object { $_.Trim() })
    if ($distros -notcontains $Distro) {
        Write-Host "Installing $Distro"
        wsl.exe --install $Distro --no-launch
        if ($LASTEXITCODE -ne 0) {
            throw "wsl --install $Distro failed with exit code $LASTEXITCODE. If Virtual Machine Platform was just enabled, restart Windows and run this script again."
        }
    }

    # The distribution creates the user in its first interactive shell only, so it is opened once by hand.
    $user = wsl.exe -d $Distro -- id -un 2>$null
    if ($LASTEXITCODE -ne 0 -or $user -eq 'root') {
        Write-Host "Create the Linux user in the $Distro shell that opens now, then run 'exit' to continue."
        wsl.exe -d $Distro
        $user = wsl.exe -d $Distro -- id -un 2>$null
        if ($LASTEXITCODE -ne 0 -or $user -eq 'root') {
            throw "$Distro has no default user yet. Run 'wsl -d $Distro' to create one, then run this script again."
        }
    }

    # WSL mounts the Windows drives with the uid of the default user when the instance starts. An instance started
    # before the user existed, by the id check above, keeps them owned by root, so chmod fails with EPERM there
    # and the playbook stops at the first copy into the Windows profile. Restarting the instance mounts them again.
    $uid = "$(wsl.exe -d $Distro --exec id -u)".Trim()
    $mountUid = "$(wsl.exe -d $Distro --exec stat -c '%u' /mnt/c)".Trim()
    if ($mountUid -ne $uid) {
        Write-Host "Restarting $Distro, whose /mnt/c is owned by uid $mountUid instead of $uid"
        wsl.exe --terminate $Distro | Out-Null
    }

    Write-Host "Running bootstrap.sh in $Distro as $user"
    # --exec passes the arguments as they are; with -- they go through the shell, which expands $ once more.
    wsl.exe -d $Distro --cd '~' --exec bash -c "curl -fsSL $rawBase/bootstrap.sh -o /tmp/dotfiles-bootstrap.sh && DOTFILES_BRANCH=$Branch bash /tmp/dotfiles-bootstrap.sh"
    if ($LASTEXITCODE -ne 0) {
        throw "bootstrap.sh failed in $Distro with exit code $LASTEXITCODE."
    }
}

$wslUtf8 = $env:WSL_UTF8
# wsl.exe writes UTF-16 to a pipe unless WSL_UTF8 is set.
$env:WSL_UTF8 = '1'
try {
    Invoke-DotfilesBootstrap -Distro $Distro -Branch $Branch -ScriptRoot $PSScriptRoot
} finally {
    $env:WSL_UTF8 = $wslUtf8
}
