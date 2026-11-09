// One registry for the UI's commands, served both to the app window (ipcMain) and to the
// browser side panel (bridge WebSocket). Handlers receive (event, ...args) like ipcMain's.

function makeRouter(ipcMain) {
  const sends = new Map(); // channel -> fn(event, ...args)
  const invokes = new Map(); // channel -> async fn(event, ...args)
  return {
    on(channel, fn) {
      sends.set(channel, fn);
      ipcMain?.on(channel, fn);
    },
    handle(channel, fn) {
      invokes.set(channel, fn);
      ipcMain?.handle(channel, fn);
    },
    /** From the bridge: fire-and-forget command. Unknown channels are ignored. */
    dispatchSend(channel, args, event = {}) {
      const fn = sends.get(channel);
      if (fn) fn(event, ...args);
      return !!fn;
    },
    /** From the bridge: request/response command. */
    async dispatchInvoke(channel, args, event = {}) {
      const fn = invokes.get(channel);
      if (!fn) throw new Error(`unknown command ${channel}`);
      return fn(event, ...args);
    },
    channels: () => ({ send: [...sends.keys()], invoke: [...invokes.keys()] }),
  };
}

module.exports = { makeRouter };
