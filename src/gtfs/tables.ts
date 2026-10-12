import { parseGtfsDate, parseGtfsTime } from './time.ts';

type Parser = (raw: string) => string | number | null;

export interface ColumnSpec {
  /** Column name in the database. */
  column: string;
  /** Header in the GTFS file, when it differs from the column name. */
  source?: string;
  required?: boolean;
  /** Used when the field is blank or the file has no such column. */
  defaultValue?: string;
  parse?: Parser;
}

export interface TableSpec {
  file: string;
  table: string;
  required: boolean;
  columns: ColumnSpec[];
}

const time: Parser = parseGtfsTime;
const date: Parser = parseGtfsDate;

// Only the GTFS columns we use. Extra columns in a feed are ignored.
export const GTFS_TABLES: TableSpec[] = [
  {
    file: 'agency.txt',
    table: 'gtfs_agency',
    required: true,
    columns: [
      // agency_id is optional in GTFS when a feed has a single agency.
      { column: 'agency_id', defaultValue: '' },
      { column: 'agency_name', required: true },
      { column: 'agency_url' },
      { column: 'agency_timezone', required: true },
    ],
  },
  {
    file: 'stops.txt',
    table: 'gtfs_stops',
    required: true,
    columns: [
      { column: 'stop_id', required: true },
      { column: 'stop_code' },
      { column: 'stop_name' },
      { column: 'stop_lat' },
      { column: 'stop_lon' },
      { column: 'location_type' },
      { column: 'parent_station' },
      { column: 'wheelchair_boarding' },
    ],
  },
  {
    file: 'routes.txt',
    table: 'gtfs_routes',
    required: true,
    columns: [
      { column: 'route_id', required: true },
      { column: 'agency_id', defaultValue: '' },
      { column: 'route_short_name' },
      { column: 'route_long_name' },
      { column: 'route_type', required: true },
      { column: 'route_color' },
      { column: 'route_text_color' },
    ],
  },
  {
    file: 'trips.txt',
    table: 'gtfs_trips',
    required: true,
    columns: [
      { column: 'trip_id', required: true },
      { column: 'route_id', required: true },
      { column: 'service_id', required: true },
      { column: 'trip_headsign' },
      { column: 'direction_id' },
      { column: 'block_id' },
      { column: 'shape_id' },
    ],
  },
  {
    file: 'stop_times.txt',
    table: 'gtfs_stop_times',
    required: true,
    columns: [
      { column: 'trip_id', required: true },
      { column: 'stop_sequence', required: true },
      { column: 'stop_id', required: true },
      { column: 'arrival_secs', source: 'arrival_time', parse: time },
      { column: 'departure_secs', source: 'departure_time', parse: time },
      { column: 'pickup_type' },
      { column: 'drop_off_type' },
      { column: 'timepoint' },
    ],
  },
  {
    file: 'calendar.txt',
    table: 'gtfs_calendar',
    required: false,
    columns: [
      { column: 'service_id', required: true },
      ...['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(
        (day) => ({ column: day, required: true }),
      ),
      { column: 'start_date', required: true, parse: date },
      { column: 'end_date', required: true, parse: date },
    ],
  },
  {
    file: 'calendar_dates.txt',
    table: 'gtfs_calendar_dates',
    required: false,
    columns: [
      { column: 'service_id', required: true },
      { column: 'date', required: true, parse: date },
      { column: 'exception_type', required: true },
    ],
  },
  {
    file: 'shapes.txt',
    table: 'gtfs_shapes',
    required: false,
    columns: [
      { column: 'shape_id', required: true },
      { column: 'shape_pt_sequence', required: true },
      { column: 'shape_pt_lat', required: true },
      { column: 'shape_pt_lon', required: true },
      { column: 'shape_dist_traveled' },
    ],
  },
];
