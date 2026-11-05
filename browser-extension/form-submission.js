// Registered only after the user enables automatic preference capture and
// grants the extension access to HTTP/HTTPS sites.
(async () => {
  if (globalThis.__jarelaFormSubmissionCaptureInstalled) return;
  globalThis.__jarelaFormSubmissionCaptureInstalled = true;
  let collectFormSubmission;
  let captureStorageKey;
  globalThis.__jarelaFormSubmissionCaptureStop = () => {
    document.removeEventListener("submit", onSubmit, true);
    if (captureStorageKey) chrome.storage.onChanged.removeListener(onStorageChanged);
    delete globalThis.__jarelaFormSubmissionCaptureInstalled;
    delete globalThis.__jarelaFormSubmissionCaptureStop;
  };

  function onStorageChanged(changes, area) {
    if (area === "local" && changes[captureStorageKey]
      && changes[captureStorageKey].newValue !== true) {
      globalThis.__jarelaFormSubmissionCaptureStop();
    }
  }

  function onSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !collectFormSubmission) return;

    const payload = collectFormSubmission(form, {
      href: location.href,
      title: document.title,
    });
    if (!payload) return;

    void chrome.runtime.sendMessage({
      type: "jarela-form-submission",
      payload,
    }).catch((err) => {
      console.warn("[jarela] form preference capture could not reach the service worker:", err);
    });
  }

  try {
    const { FORM_SUBMISSION_CAPTURE_KEY } = await import(
      chrome.runtime.getURL("lib/config.mjs")
    );
    captureStorageKey = FORM_SUBMISSION_CAPTURE_KEY;
    chrome.storage.onChanged.addListener(onStorageChanged);
    const stored = await chrome.storage.local.get(FORM_SUBMISSION_CAPTURE_KEY);
    if (stored?.[FORM_SUBMISSION_CAPTURE_KEY] !== true) {
      globalThis.__jarelaFormSubmissionCaptureStop();
      return;
    }

    ({ collectFormSubmission } = await import(
      chrome.runtime.getURL("lib/form-submission.mjs")
    ));
    if (!globalThis.__jarelaFormSubmissionCaptureInstalled) return;
    document.addEventListener("submit", onSubmit, true);
  } catch (err) {
    globalThis.__jarelaFormSubmissionCaptureStop();
    console.warn("[jarela] could not install form preference capture:", err);
  }
})();
