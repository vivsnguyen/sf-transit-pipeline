-- Static GTFS schedule data, versioned per feed download.
--
-- Every GTFS row belongs to a feed_version. A new feed is loaded alongside the
-- current one and then activated in a single transaction, so readers always see
-- one complete schedule and never a half-loaded one.

CREATE TABLE feed_versions (
  id            serial PRIMARY KEY,
  operator_id   text        NOT NULL,
  sha256        text        NOT NULL,
  source_url    text,
  status        text        NOT NULL DEFAULT 'loading'
                CHECK (status IN ('loading', 'active', 'superseded', 'failed')),
  row_counts    jsonb,
  validation    jsonb,
  error         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  activated_at  timestamptz
);

-- At most one active schedule per operator.
CREATE UNIQUE INDEX feed_versions_one_active
  ON feed_versions (operator_id) WHERE status = 'active';

CREATE TABLE gtfs_agency (
  feed_version_id int  NOT NULL REFERENCES feed_versions ON DELETE CASCADE,
  agency_id       text NOT NULL,
  agency_name     text NOT NULL,
  agency_url      text,
  agency_timezone text NOT NULL,
  PRIMARY KEY (feed_version_id, agency_id)
);

CREATE TABLE gtfs_stops (
  feed_version_id     int  NOT NULL REFERENCES feed_versions ON DELETE CASCADE,
  stop_id             text NOT NULL,
  stop_code           text,
  stop_name           text,
  stop_lat            double precision,
  stop_lon            double precision,
  location_type       smallint,
  parent_station      text,
  wheelchair_boarding smallint,
  PRIMARY KEY (feed_version_id, stop_id)
);

CREATE TABLE gtfs_routes (
  feed_version_id  int  NOT NULL REFERENCES feed_versions ON DELETE CASCADE,
  route_id         text NOT NULL,
  agency_id        text NOT NULL,
  route_short_name text,
  route_long_name  text,
  route_type       smallint NOT NULL,
  route_color      text,
  route_text_color text,
  PRIMARY KEY (feed_version_id, route_id)
);

CREATE TABLE gtfs_trips (
  feed_version_id int  NOT NULL REFERENCES feed_versions ON DELETE CASCADE,
  trip_id         text NOT NULL,
  route_id        text NOT NULL,
  service_id      text NOT NULL,
  trip_headsign   text,
  direction_id    smallint,
  block_id        text,
  shape_id        text,
  PRIMARY KEY (feed_version_id, trip_id)
);

-- Times are seconds after the start of the service day. GTFS allows values
-- past 24:00:00 for trips that run after midnight, so these are not times of day.
CREATE TABLE gtfs_stop_times (
  feed_version_id   int  NOT NULL REFERENCES feed_versions ON DELETE CASCADE,
  trip_id           text NOT NULL,
  stop_sequence     int  NOT NULL,
  stop_id           text NOT NULL,
  arrival_secs      int,
  departure_secs    int,
  pickup_type       smallint,
  drop_off_type     smallint,
  timepoint         smallint,
  PRIMARY KEY (feed_version_id, trip_id, stop_sequence)
);

CREATE INDEX gtfs_stop_times_stop ON gtfs_stop_times (feed_version_id, stop_id);

CREATE TABLE gtfs_calendar (
  feed_version_id int  NOT NULL REFERENCES feed_versions ON DELETE CASCADE,
  service_id      text NOT NULL,
  monday          smallint NOT NULL,
  tuesday         smallint NOT NULL,
  wednesday       smallint NOT NULL,
  thursday        smallint NOT NULL,
  friday          smallint NOT NULL,
  saturday        smallint NOT NULL,
  sunday          smallint NOT NULL,
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  PRIMARY KEY (feed_version_id, service_id)
);

CREATE TABLE gtfs_calendar_dates (
  feed_version_id int      NOT NULL REFERENCES feed_versions ON DELETE CASCADE,
  service_id      text     NOT NULL,
  date            date     NOT NULL,
  exception_type  smallint NOT NULL,
  PRIMARY KEY (feed_version_id, service_id, date)
);

CREATE TABLE gtfs_shapes (
  feed_version_id     int NOT NULL REFERENCES feed_versions ON DELETE CASCADE,
  shape_id            text NOT NULL,
  shape_pt_sequence   int  NOT NULL,
  shape_pt_lat        double precision NOT NULL,
  shape_pt_lon        double precision NOT NULL,
  shape_dist_traveled double precision,
  PRIMARY KEY (feed_version_id, shape_id, shape_pt_sequence)
);
