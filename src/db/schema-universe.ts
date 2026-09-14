import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * El universo: fundamentales de TODAS las empresas que declaran a la SEC, no
 * solo de las que tienes.
 *
 * Vive aqui, y no en `schema.ts`, por lo de siempre: ese archivo esta en solo
 * lectura en el equipo. `drizzle.config.full.ts` incluye los tres, asi que
 * `db:generate` sigue viendo el esquema completo.
 *
 * Que aterriza en esta tabla: la historia YA destilada por `buildFinancials`,
 * no los hechos crudos del zip. El zip son gigabytes de XBRL; lo que el motor
 * necesita son ocho ejercicios con diez cifras cada uno. Guardar lo destilado
 * deja la tabla en unos pocos miles de filas y hace que el oraculo pueda
 * valorar el mercado entero leyendo la base en vez de la red.
 */
export const universeCompanies = sqliteTable(
  "universe_companies",
  {
    /** CIK a 10 digitos con ceros: la clave real de la SEC. */
    cik: text("cik").primaryKey(),
    /** Puede faltar: hay declarantes sin ticker en el mapa publico. */
    ticker: text("ticker"),
    name: text("name").notNull(),
    /** SIC de la SEC, para agrupar por sector sin depender de un tercero. */
    sic: text("sic"),

    /**
     * `FinancialsView.years` en JSON. Es lo que consume el motor tal cual, sin
     * volver a armarlo: el mismo objeto que hoy devuelve `companyFinancials`.
     */
    years: text("years").notNull(),
    sharesOut: real("shares_out"),

    /**
     * Cobertura, en columnas y no dentro del JSON, porque de esto hay que
     * poder filtrar en SQL: el ranking solo puede mirar lo `usable`, y sin
     * esa condicion las primeras posiciones se llenarian de empresas que
     * parecen baratisimas porque apenas se les pudo leer nada.
     */
    covYears: integer("cov_years").notNull(),
    covConcepts: integer("cov_concepts").notNull(),
    covLastFy: integer("cov_last_fy"),
    usable: integer("usable", { mode: "boolean" }).notNull(),

    /** De que volcado nocturno salio esta fila (YYYY-MM-DD). */
    sourceDate: text("source_date").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("universe_ticker_idx").on(t.ticker),
    // El indice que de verdad se usa: "dame el universo valorable".
    index("universe_usable_idx").on(t.usable),
  ],
);

export type UniverseCompany = typeof universeCompanies.$inferSelect;

/**
 * Una linea por pasada de ingesta. Sin esto no hay forma de responder a "¿de
 * cuantas empresas sabemos algo?" ni de ver que la cobertura empeoro tras un
 * cambio — y la cobertura es la que decide si un ranking significa algo o es
 * un sesgo de supervivencia bien maquetado.
 */
export const universeRuns = sqliteTable("universe_runs", {
  id: text("id").primaryKey(),
  /** Fecha del volcado de la SEC que se leyo. */
  sourceDate: text("source_date").notNull(),
  /** Empresas en el archivo. */
  seen: integer("seen").notNull(),
  /** Empresas escritas con alguna cifra. */
  parsed: integer("parsed").notNull(),
  /** Empresas que pasan el minimo para entrar en un ranking. */
  usable: integer("usable").notNull(),
  /** Segundos que tardo la pasada. */
  seconds: real("seconds").notNull(),
  note: text("note"),
  at: integer("at").notNull(),
});

export type UniverseRun = typeof universeRuns.$inferSelect;
