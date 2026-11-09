declare const chrome: any;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const readButton = $<HTMLButtonElement>("read");
const recordButton = $<HTMLButtonElement>("record");
const status = $<HTMLParagraphElement>("status");

function say(text: string, error = false): void {
  status.textContent = text;
  status.classList.toggle("error", error);
}

async function ask<T extends { ok: boolean; error?: string }>(message: Record<string, unknown>): Promise<T> {
  const answer = (await chrome.runtime.sendMessage({ target: "background", ...message })) as T | undefined;
  if (!answer?.ok) throw new Error(answer?.error ?? "The extension did not answer.");
  return answer;
}

async function activeTab(): Promise<{ id: number; url?: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No tab to work on.");
  return tab;
}

const restricted = (url?: string) => !url || !/^(https?|file):/i.test(url) || /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i.test(url);

function showRecording(on: boolean, since?: number): void {
  recordButton.classList.toggle("on", on);
  recordButton.firstChild!.textContent = on ? "Stop and save the recording" : "Record this tab";
  if (on && since) say(`Recording since ${new Date(since).toLocaleTimeString()}. You can close this window; open it again to stop.`);
}

readButton.addEventListener("click", async () => {
  readButton.disabled = true;
  try {
    const tab = await activeTab();
    if (restricted(tab.url)) throw new Error("The browser does not let extensions read this page (its own pages and the extension stores).");
    say("Reading the page… it scrolls down once and back.");
    const r = await ask<{ ok: boolean; filename: string; animations: number; gsap: boolean }>({ type: "read", tabId: tab.id });
    say(`Saved ${r.animations} animations${r.gsap ? " (GSAP timeline read)" : ""} to Downloads/${r.filename}. In Frame Lens: the web tool with "inbox".`);
  } catch (error) {
    say((error as Error).message, true);
  } finally {
    readButton.disabled = false;
  }
});

recordButton.addEventListener("click", async () => {
  recordButton.disabled = true;
  try {
    if (recordButton.classList.contains("on")) {
      await ask({ type: "record-stop" });
      showRecording(false);
      say("Saving the recording to Downloads/FrameLens… In Frame Lens: any video tool with source \"inbox\".");
    } else {
      const tab = await activeTab();
      if (restricted(tab.url)) throw new Error("The browser does not let extensions record this page.");
      const r = await ask<{ ok: boolean; startedAt: number }>({ type: "record-start", tabId: tab.id });
      showRecording(true, r.startedAt);
    }
  } catch (error) {
    say((error as Error).message, true);
  } finally {
    recordButton.disabled = false;
  }
});

ask<{ ok: boolean; recording: boolean; startedAt?: number; lastSaved?: { filename?: string; error?: string } }>({ type: "status" })
  .then((s) => {
    showRecording(s.recording, s.startedAt);
    if (!s.recording && s.lastSaved?.filename) say(`Last recording: Downloads/${s.lastSaved.filename}.`);
    if (!s.recording && s.lastSaved?.error) say(s.lastSaved.error, true);
  })
  .catch(() => undefined);
