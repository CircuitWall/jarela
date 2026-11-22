// Shared contract for a hands-free voice capture. `finish` ends the turn and
// delivers a transcript; `cancel` discards it without sending.
export interface CaptureControls {
  finish(): void;
  cancel(): void;
}
