/** Shared admission for manual and HTTP WebRTC offers. */
export function createSignalingOfferGate({ session, isReady }) {
  let admitted = null;

  const isBusy = () => {
    const { status } = session.snapshot();
    return Boolean(admitted) || ['preparing', 'running', 'stalled'].includes(status);
  };

  function acceptOffer(offer, { signal } = {}) {
    if (signal?.aborted) throw conflict('Offer request was cancelled.');
    if (!isReady()) throw conflict('Wait for the editor receiver to be ready and select WebRTC before connecting.');
    if (isBusy()) throw conflict('A WebRTC sender is already active or connecting. Disconnect it first.');

    const owner = {};
    admitted = owner;
    let result;
    try {
      result = session.acceptOffer(offer);
    } catch (error) {
      if (admitted === owner) admitted = null;
      throw error;
    }
    const sessionId = session.snapshot().sessionId;
    const cancelOwnedSession = () => {
      if (admitted === owner && session.snapshot().sessionId === sessionId) {
        session.reset('Signaling request cancelled.');
      }
    };
    const onAbort = () => cancelOwnedSession();
    signal?.addEventListener('abort', onAbort, { once: true });

    return Promise.resolve(result).finally(() => {
      // Keep ownership through the HTTP response write that follows promise
      // resolution. If its client has already gone away, the AbortSignal still
      // tears down this session before the admission lock is released.
      setImmediate(() => {
        signal?.removeEventListener('abort', onAbort);
        if (admitted === owner) admitted = null;
      });
    });
  }

  return Object.freeze({ acceptOffer, isBusy });
}

function conflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}
