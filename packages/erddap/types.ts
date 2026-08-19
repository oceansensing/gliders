/** The shapes this package hands out. Nothing here knows about the DOM. */

/** One deployment, as the catalog lists it. Times are epoch seconds. */
export interface DeploymentSummary {
  id: string;
  title: string;
  institution: string;
  start: number;
  end: number;
  west: number;
  east: number;
  south: number;
  north: number;
}

/** One column of a dataset, as `info/<id>/index.json` describes it. */
export interface VariableInfo {
  name: string;
  /** ERDDAP's own type name: double, float, int, String, … */
  type: string;
  units?: string;
  longName?: string;
  standardName?: string;
  /** ERDDAP's coarse grouping — Temperature, Salinity, Location, … The DAC
      fills it in for nearly everything, and it is the only thing that
      separates a science variable from a flight-computer readout without a
      hand-maintained list. */
  category?: string;
  /** `actual_range`, where the dataset publishes one. */
  range?: [number, number];
  /** Rolled-up QARTOD flag column for this variable, where one exists. */
  qcColumn?: string;
  /** True for a column that is itself a flag, an id, or a timestamp — the
      things a reader never wants to see plotted as a variable. */
  ancillary: boolean;
}

export interface DatasetInfo {
  id: string;
  title: string;
  institution: string;
  summary: string;
  /** Epoch seconds. */
  start: number;
  end: number;
  bounds: { west: number; east: number; south: number; north: number };
  variables: VariableInfo[];
  /** Set on every DAC dataset seen so far, but not assumed: the code falls
      back to `time`/`latitude`/`longitude` where the precise pair is absent. */
  timeVar: string;
  latVar: string;
  lonVar: string;
  /** Present where the dataset publishes them; used for the depth axis and
      for TEOS-10, which needs pressure rather than depth. */
  depthVar?: string;
  pressureVar?: string;
  /** Global attributes worth showing, kept raw. */
  attributes: Record<string, string>;
}

/** A rectangular block of numbers. Every column is the same length. */
export interface TableData {
  rows: number;
  /** Column name → values. `time` is epoch seconds; everything is Float64,
      including flags, so one container serves the whole page. */
  columns: Map<string, Float64Array>;
  units: Map<string, string>;
  /** What was asked of the server, so a caption can say what is on screen. */
  resolution: Resolution;
  /** True when a chunk failed and the rest was kept. */
  partial: boolean;
}

/** How much of the record a fetch asked for. */
export interface Resolution {
  kind: 'full' | 'binned';
  /** Depth bin in metres, when `kind` is 'binned'. */
  binMetres?: number;
}
