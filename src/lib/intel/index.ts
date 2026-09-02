/**
 * Motor de inteligencia: noticia → evento → impacto en tesis → score → prioridad.
 * Ver docs/INTEL-ARCHITECTURE.md.
 */
export {
  INTEL_LIMITS,
  LAST_RUN_KEY,
  lastRun,
  processEvents,
  recentEvents,
  setEventFeedback,
  type EventSource,
  type EventWithSources,
  type RunStats,
} from "./run";
export {
  calibrationReport,
  loadWeights,
  saveWeights,
  suggestWeights,
  normalizeWeights,
  type CalibrationReport,
} from "./calibration";
export { SIGNAL_WEIGHTS, type Weights } from "./score";
export {
  EVENT_TYPE_LABELS,
  FEEDBACK_VALUES,
  HORIZON_LABELS,
  PRIORITIES,
  PRIORITY_LABELS,
  type Feedback,
  type Priority,
} from "./types";
