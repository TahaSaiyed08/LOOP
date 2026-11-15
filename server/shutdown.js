// Graceful shutdown for SIGTERM / SIGINT. Render sends SIGTERM on every deploy or restart, then SIGKILL about
// 30 s later, so everything here is bounded by SHUTDOWN_TIMEOUT_MS (default 25 s) plus a short flush window.
//
// Order: 1 stop accepting new connections   2 let active HTTP requests finish (a chat answer waiting on Gemini,
//        a seed, a paper buy) and the running news pipeline (matching + email notifications)
//        3 flush pending storage writes   4 close the database connections.
// If step 2 runs out of time, the remaining connections are closed and the shutdown continues; anything
// interrupted is safe to redo (saves are transactions; an interrupted email send is recovered on a later
// run, see repo.recoverStaleSending).

// Counts requests that have started and not yet finished. Install it before every route.
function requestTracker() {
  let active = 0;
  let draining = false;
  const middleware = (req, res, next) => {
    active++;
    let ended = false;
    const end = () => { if (!ended) { ended = true; active--; } };
    res.once('finish', end);
    res.once('close', end);
    if (draining) res.setHeader('Connection', 'close'); // a keep-alive client is told to reconnect elsewhere
    next();
  };
  return { middleware, active: () => active, drain: () => { draining = true; } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// -> 'ok' | 'error' | 'timeout' (the timer never keeps the process alive on its own)
function settle(fn, ms) {
  let timer;
  const limit = new Promise((r) => { timer = setTimeout(() => r('timeout'), ms); if (timer.unref) timer.unref(); });
  const work = Promise.resolve().then(fn).then(() => 'ok', () => 'error');
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

// -> shutdown(signal): Promise<{ timedOut, flushed, waitedMs }>. Calling it again returns the same promise.
function createShutdown({ server, tracker, pipelineIdle = () => true, flush = async () => {}, close = async () => {},
  timeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 25000, flushTimeoutMs = 4000, log = console } = {}) {
  let started = null;
  return function shutdown(signal = 'SIGTERM') {
    if (started) return started;
    started = (async () => {
      const t0 = Date.now();
      tracker.drain();
      server.close(); // no new connections
      if (server.closeIdleConnections) server.closeIdleConnections();
      log.log(`[shutdown] ${signal}: finishing ${tracker.active()} active request(s)${pipelineIdle() ? '' : ' and the news pipeline'} (up to ${Math.round(timeoutMs / 1000)} s)`);
      let timedOut = false;
      for (;;) {
        if (tracker.active() === 0 && pipelineIdle()) break;
        if (Date.now() - t0 >= timeoutMs) { timedOut = true; break; }
        if (server.closeIdleConnections) server.closeIdleConnections(); // keep-alive sockets that just went idle
        await sleep(50);
      }
      if (timedOut) log.warn(`[shutdown] WARNING: gave up waiting after ${Math.round(timeoutMs / 1000)} s (${tracker.active()} request(s) still open${pipelineIdle() ? '' : ', news pipeline still running'}); closing them`);
      if (server.closeAllConnections) server.closeAllConnections();
      const f = await settle(flush, flushTimeoutMs);
      if (f === 'timeout') log.warn(`[shutdown] WARNING: storage writes did not finish within ${Math.round(flushTimeoutMs / 1000)} s; they are lost if the database never received them`);
      if (f === 'error') log.warn('[shutdown] WARNING: some storage writes failed during shutdown (see the [store] ERROR above)');
      const flushed = f === 'ok';
      await settle(close, 2000);
      log.log(`[shutdown] done in ${Date.now() - t0} ms`);
      return { timedOut, flushed, waitedMs: Date.now() - t0 };
    })();
    return started;
  };
}

module.exports = { requestTracker, createShutdown };
