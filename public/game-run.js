export class StaleGameRunError extends Error {
  constructor(gameId = null) {
    super("对局已经切换，忽略旧对局返回的异步结果");
    this.name = "StaleGameRunError";
    this.code = "STALE_GAME_RUN";
    this.gameId = gameId;
  }
}

export function isStaleGameRunError(error) {
  return error?.code === "STALE_GAME_RUN" || error?.name === "AbortError";
}

export function createGameRunCoordinator() {
  let generation = 0;
  let current = null;

  const cancel = () => {
    generation += 1;
    current?.controller.abort();
    current = null;
  };

  const begin = (gameId) => {
    cancel();
    const controller = new AbortController();
    current = {
      generation,
      gameId: gameId || null,
      controller
    };
    return Object.freeze({
      generation,
      gameId: current.gameId,
      signal: controller.signal
    });
  };

  const isCurrent = (run) => Boolean(
    run
    && current
    && run.generation === current.generation
    && run.gameId === current.gameId
    && run.signal === current.controller.signal
    && !run.signal.aborted
  );

  const assertCurrent = (run) => {
    if (!isCurrent(run)) throw new StaleGameRunError(run?.gameId || null);
    return run;
  };

  return { begin, cancel, isCurrent, assertCurrent };
}
