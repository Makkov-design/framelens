/** The parts of chrome.downloads this uses, so it can be tested without a browser. */
export interface DownloadsApi {
  download(options: Record<string, unknown>): Promise<number>;
  search(query: { id: number }): Promise<{ id: number; state?: string; error?: string; filename?: string }[]>;
  onChanged: {
    addListener(listener: (delta: DownloadDelta) => void): void;
    removeListener(listener: (delta: DownloadDelta) => void): void;
  };
}

export interface DownloadDelta {
  id: number;
  state?: { current?: string };
  error?: { current?: string };
  filename?: { current?: string };
}

/** Download errors in plain words (the browser reports codes such as FILE_NO_SPACE or USER_CANCELED). */
function explain(error: string | undefined): string {
  if (!error) return "the browser stopped it";
  if (/USER_CANCELED/.test(error)) return "it was cancelled";
  if (/NO_SPACE/.test(error)) return "the disk is full";
  if (/ACCESS_DENIED|FILE_BLOCKED|FILE_SECURITY_CHECK_FAILED|FILE_VIRUS_INFECTED/.test(error)) return `the browser or the system refused the file (${error})`;
  if (/NAME_TOO_LONG|TOO_LARGE|FILE_FAILED/.test(error)) return `the file could not be written (${error})`;
  return error;
}

/**
 * Starts a download and resolves once it is complete, with the path it was saved to. An interrupted or cancelled
 * download rejects with the reason: only a file that is really there counts as saved.
 */
export async function downloadAndWait(api: DownloadsApi, options: Record<string, unknown>, timeoutMs = 10 * 60_000): Promise<string> {
  let id = -1;
  let listener: ((delta: DownloadDelta) => void) | undefined;
  const finished = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The browser did not finish saving the file.")), timeoutMs);
    const settle = (state: string | undefined, error: string | undefined, filename: string | undefined) => {
      if (state === "complete") {
        clearTimeout(timer);
        resolve(filename ?? "");
      } else if (state === "interrupted") {
        clearTimeout(timer);
        reject(new Error(`The file was not saved: ${explain(error)}.`));
      }
    };
    listener = (delta) => {
      if (delta.id !== id) return;
      if (delta.state?.current) {
        void api.search({ id }).then(
          ([item]) => settle(delta.state?.current, delta.error?.current ?? item?.error, item?.filename),
          () => settle(delta.state?.current, delta.error?.current, undefined),
        );
      }
    };
    api.onChanged.addListener(listener);
    // The listener is in place before the id is known; a download that already ended is caught by the search.
    api
      .download(options)
      .then(async (started) => {
        id = started;
        const [item] = await api.search({ id });
        settle(item?.state, item?.error, item?.filename);
      })
      .catch((error: Error) => {
        clearTimeout(timer);
        reject(new Error(`The file was not saved: ${error?.message ?? String(error)}`));
      });
  });
  try {
    return await finished;
  } finally {
    if (listener) api.onChanged.removeListener(listener);
  }
}
