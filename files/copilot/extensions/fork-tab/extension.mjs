import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { joinSession } from "@github/copilot-sdk/extension";

const execFileAsync = promisify(execFile);
const herdrBin = process.env.HERDR_BIN_PATH || "herdr";

async function herdr(...args) {
    const { stdout } = await execFileAsync(herdrBin, args, { timeout: 15000 });
    // Commands such as `pane run` print nothing on success.
    return stdout.trim() ? JSON.parse(stdout).result : undefined;
}

function quote(value) {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

async function forkToTab(context) {
    const paneId = process.env.HERDR_PANE_ID;
    if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_SOCKET_PATH || !paneId) {
        await session.log("/fork-tab works only inside a herdr pane.", { level: "error" });
        return;
    }

    const name = context.args.trim() || undefined;
    // sessions.fork is a server-scoped RPC that the SDK does not expose on the session object.
    const forked = await session.connection.sendRequest("sessions.fork", {
        sessionId: context.sessionId,
        ...(name ? { name } : {}),
    });

    const { pane } = await herdr("pane", "get", paneId);
    // Without a name, the tab keeps herdr's default label so herdr-tab-names.mjs can name it.
    const { root_pane: newPane } = await herdr(
        "tab", "create",
        "--workspace", pane.workspace_id,
        "--cwd", pane.cwd,
        ...(name ? ["--label", name] : []),
        "--focus",
    );
    await herdr("pane", "run", newPane.pane_id, `copilot --resume=${quote(forked.sessionId)}`);

    await session.log(`Opened fork ${forked.sessionId} in a new herdr tab.`);
}

const session = await joinSession({
    commands: [
        {
            name: "fork-tab",
            description: "Fork this session and open the fork in a new herdr tab, keeping this tab on the current session",
            handler: async (context) => {
                try {
                    await forkToTab(context);
                } catch (error) {
                    await session.log(`/fork-tab failed: ${error?.message ?? error}`, { level: "error" });
                }
            },
        },
    ],
});
