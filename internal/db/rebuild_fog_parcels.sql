CREATE OR REPLACE PROCEDURE rebuild_fog_parcels()
LANGUAGE plpgsql
AS $$
DECLARE
  cell_rec RECORD;
  buf_box geometry;
  cell_box geometry;
BEGIN
  CREATE TEMP TABLE temp_new_fog_parcels (
    road_geom   geometry(LineString, 4326),
    parcel_geom geometry(Polygon, 4326),
    area_m2     double precision
  ) ON COMMIT DROP;

  FOR cell_rec IN (
    SELECT DISTINCT 
      floor(ST_X(ST_Centroid(geom))::numeric / 0.05) as gx,
      floor(ST_Y(ST_Centroid(geom))::numeric / 0.05) as gy
    FROM osm_road_edges
  ) LOOP
    cell_box := ST_MakeEnvelope(cell_rec.gx * 0.05, cell_rec.gy * 0.05, (cell_rec.gx + 1) * 0.05, (cell_rec.gy + 1) * 0.05, 4326);
    buf_box := ST_Expand(cell_box, 0.003);

    INSERT INTO temp_new_fog_parcels (road_geom, parcel_geom, area_m2)
    WITH lines AS (
      SELECT geom FROM osm_road_edges 
      WHERE geom && buf_box
        AND highway IN ('motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street')
    ),
    noded AS (
      SELECT ST_Node(ST_Collect(geom)) AS g FROM lines
    ),
    raw_blocks AS (
      SELECT ST_ForcePolygonCCW(ST_SimplifyPreserveTopology((ST_Dump(ST_Polygonize(g))).geom, 0.00006)) AS poly
      FROM noded
    ),
    valid_blocks AS (
      SELECT poly, ST_PointOnSurface(poly) AS center
      FROM raw_blocks
      WHERE ST_Area(poly::geography) BETWEEN 100 AND 1500000
        AND ST_Contains(cell_box, ST_PointOnSurface(poly))
    ),
    boundary_segs AS (
      SELECT b.poly, b.center,
             ST_PointN(ST_ExteriorRing(b.poly), s.n) AS p1,
             ST_PointN(ST_ExteriorRing(b.poly), s.n+1) AS p2
      FROM valid_blocks b,
      LATERAL generate_series(1, ST_NPoints(ST_ExteriorRing(b.poly))-1) AS s(n)
      WHERE ST_Distance(ST_PointN(ST_ExteriorRing(b.poly), s.n), ST_PointN(ST_ExteriorRing(b.poly), s.n+1)) > 0.00005
    ),
    triangles AS (
      SELECT ST_MakeLine(bs.p1, bs.p2) AS road_geom,
             CASE 
               WHEN ST_CoveredBy(ST_MakePolygon(ST_MakeLine(ARRAY[bs.p1, bs.p2, bs.center, bs.p1])), bs.poly)
                 THEN ST_MakePolygon(ST_MakeLine(ARRAY[bs.p1, bs.p2, bs.center, bs.p1]))
               ELSE 
                 COALESCE(
                   (SELECT (ST_Dump(ST_CollectionExtract(ST_Intersection(
                     ST_MakePolygon(ST_MakeLine(ARRAY[
                       bs.p1, bs.p2,
                       ST_SetSRID(ST_MakePoint(
                         (ST_X(bs.p1)+ST_X(bs.p2))/2.0 - (ST_Y(bs.p2)-ST_Y(bs.p1))*0.4,
                         (ST_Y(bs.p1)+ST_Y(bs.p2))/2.0 + (ST_X(bs.p2)-ST_X(bs.p1))*0.4
                       ), 4326),
                       bs.p1
                     ])), bs.poly), 3))).geom LIMIT 1),
                   ST_MakePolygon(ST_MakeLine(ARRAY[bs.p1, bs.p2, bs.center, bs.p1]))
                 )
             END AS parcel_geom
      FROM boundary_segs bs
    )
    SELECT road_geom, parcel_geom, ST_Area(parcel_geom::geography)
    FROM triangles
    WHERE ST_GeometryType(parcel_geom) = 'ST_Polygon' AND ST_Area(parcel_geom::geography) > 5;

  END LOOP;

  TRUNCATE TABLE fog_parcels RESTART IDENTITY;

  INSERT INTO fog_parcels (parcel_id, road_geom, parcel_geom, area_m2)
  SELECT ROW_NUMBER() OVER () AS parcel_id, road_geom, parcel_geom, area_m2
  FROM temp_new_fog_parcels;

END;
$$;
