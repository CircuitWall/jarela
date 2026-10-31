import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";

const READ_ERROR = "Could not read that image. Try another one.";

export function useIconFile(
  onChange: (icon: string | null) => void,
  validateFile?: (file: File) => string | null,
) {
  const [iconError, setIconError] = useState<string | null>(null);
  const active = useRef<FileReader | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  const cancelRead = useCallback(() => {
    const reader = active.current;
    active.current = null;
    if (!reader) return;
    reader.onload = reader.onerror = reader.onabort = null;
    if (reader.readyState === FileReader.LOADING) reader.abort();
  }, []);
  useEffect(() => cancelRead, [cancelRead]);

  const setIcon = useCallback((icon: string | null) => {
    cancelRead();
    setIconError(null);
    onChangeRef.current(icon);
  }, [cancelRead]);

  const handleIconFile = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    event.currentTarget.value = "";
    cancelRead();
    const validationError = validateFile?.(file) ?? null;
    setIconError(validationError);
    if (validationError) return;

    const reader = new FileReader();
    active.current = reader;
    reader.onload = () => {
      if (active.current !== reader) return;
      const result = reader.result;
      cancelRead();
      if (typeof result === "string") onChangeRef.current(result);
      else setIconError(READ_ERROR);
    };
    reader.onerror = reader.onabort = () => {
      if (active.current !== reader) return;
      cancelRead();
      setIconError(READ_ERROR);
    };
    try {
      reader.readAsDataURL(file);
    } catch {
      cancelRead();
      setIconError(READ_ERROR);
    }
  }, [cancelRead, validateFile]);

  return { handleIconFile, setIcon, iconError };
}
