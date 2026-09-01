/**
 * Motor de inteligencia: noticia → evento → impacto en tesis → score → prioridad.
 * Ver docs/INTEL-ARCHITECTURE.md.
 */
export {
  INTEL_LIMITS,
  processEvents,
  recentEvents,
  setEventFeedback,
  type EventSource,
  type EventWithSources,
  type RunStats,
} from "./run";
export {
  EVENT_TYPE_LABELS,
  FEEDBACK_VALUES,
  HORIZON_LABELS,
  PRIORITIES,
  PRIORITY_LABELS,
  type Feedback,
  type Priority,
} from "./types";
