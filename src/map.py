import geopandas as gpd
from lonboard import Map, ScatterplotLayer, PathLayer, SolidPolygonLayer

from constants import (
    MAP_LAYERS,
    MAP_DIR_PATH,
)

def create_map(
    map_dir_path=MAP_DIR_PATH,
    map_layers=MAP_LAYERS
):
    layers = []

    for layer_info in map_layers.values():
        file_path = layer_info["path"]
        color = layer_info["color"]
        width = layer_info.get("width", 1)
        
        gdf = gpd.read_file(file_path)
        
        dostepne_typy = gdf.geom_type.unique()
        
        for typ_geometrii in dostepne_typy:
            subset = gdf[gdf.geom_type == typ_geometrii]
            
            if typ_geometrii in ["Point", "MultiPoint"]:
                layers.append(ScatterplotLayer.from_geopandas(
                    subset,
                    get_fill_color=color,
                    get_radius=width,
                    opacity=1.0
                ))
                
            elif typ_geometrii in ["LineString", "MultiLineString"]:
                layers.append(PathLayer.from_geopandas(
                    subset,
                    get_color=color,
                    get_width=width,
                    opacity=1.0
                ))
                
            elif typ_geometrii in ["Polygon", "MultiPolygon"]:
                layers.append(SolidPolygonLayer.from_geopandas(
                    subset,
                    get_fill_color=color,
                    opacity=1.0
                ))

    m = Map(
        layers=layers, 
        basemap_style="dark"
    )
    
    wyjsciowy_plik = str(map_dir_path / "driven.html")
    m.to_html(wyjsciowy_plik)