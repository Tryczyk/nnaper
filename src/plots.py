from pathlib import Path
import psycopg
import pandas as pd
import numpy as np
import plotly.express as px
import plotly.graph_objects as go

from constants import DB_URL, PLOTS_DIR


def save_html_plot(fig: go.Figure, filename: str):
    """Zapisuje figurę Plotly jako samodzielny, interaktywny plik HTML."""
    out_path = PLOTS_DIR / filename
    fig.write_html(str(out_path), include_plotlyjs="cdn")
    print(f"  -> Zapisano interaktywny wykres: {filename}")


# =====================================================================
# 1. GSENSORD
# =====================================================================
def plot_gsensord(df: pd.DataFrame):
    if df.empty:
        return
    print("\n[+] Generowanie wykresów interaktywnych GSENSORD...")

    # Pobieramy próbkę i sortujemy po indeksie, żeby zachować chronologię
    sample_df = df.sample(min(len(df), 25000), random_state=42).sort_index()
    sample_df["g_mag"] = np.sqrt(sample_df["g_x"]**2 + sample_df["g_y"]**2 + sample_df["g_z"]**2)

    # 1. Interaktywny 3D Scatter (obracanie, zoom 3D)
    fig_3d = px.scatter_3d(
        sample_df,
        x="g_x",
        y="g_y",
        z="g_z",
        color="g_mag",
        color_continuous_scale="Plasma",
        opacity=0.6,
        title="GSENSORD: Przestrzenny rozkład przeciążeń 3D (GX, GY, GZ)"
    )
    fig_3d.update_traces(marker=dict(size=2.5))
    fig_3d.update_layout(template="plotly_dark")
    save_html_plot(fig_3d, "gsensord_3d_scatter.html")

    # 2. Punkty 2D (Scatter zamiast linii łączącej) oraz histogramy dla każdej osi
    for axis, color_hex in [("g_x", "#38bdf8"), ("g_y", "#f97316"), ("g_z", "#22c55e")]:
        # Wykres punktowy (markers) — brak „sieci”, czyste punkty pomiarowe
        fig_pts = go.Figure()
        fig_pts.add_trace(go.Scattergl(
            x=sample_df.index,
            y=sample_df[axis],
            mode="markers",
            marker=dict(size=3, color=color_hex, opacity=0.7),
            name=axis.upper()
        ))
        fig_pts.update_layout(
            title=f"GSENSORD: Przebieg punktowy parametru {axis.upper()} (2D)",
            xaxis_title="Indeks pomiaru",
            yaxis_title=f"Przeciążenie {axis.upper()} [G]",
            template="plotly_dark"
        )
        save_html_plot(fig_pts, f"gsensord_points_{axis}.html")

        # Histogram
        fig_hist = px.histogram(
            df,
            x=axis,
            nbins=80,
            title=f"GSENSORD: Histogram rozkładu {axis.upper()}",
            color_discrete_sequence=[color_hex]
        )
        fig_hist.update_layout(template="plotly_dark", yaxis_title="Liczebność")
        save_html_plot(fig_hist, f"gsensord_hist_{axis}.html")


# =====================================================================
# 2. GPRMC
# =====================================================================
def plot_gprmc(df: pd.DataFrame):
    if df.empty:
        return
    print("\n[+] Generowanie wykresów interaktywnych GPRMC...")
    valid_coords = df.dropna(subset=["latitude", "longitude"])

    # 1. Mapa trasy 2D (ScatterGL z prędkością w skali kolorów)
    fig_map = px.scatter(
        valid_coords,
        x="longitude",
        y="latitude",
        color="speed_knots",
        color_continuous_scale="Turbo",
        title="GPRMC: Mapa trasy 2D (Długość vs Szerokość geograficzna)",
        labels={"longitude": "Długość geograficzna [°E]", "latitude": "Szerokość geograficzna [°N]"}
    )
    fig_map.update_traces(marker=dict(size=4, opacity=0.8))
    fig_map.update_layout(template="plotly_dark")
    save_html_plot(fig_map, "gprmc_map_lat_lon_2d.html")

    # 2. Szerokość geograficzna w czasie (punkty)
    fig_lat = px.scatter(
        valid_coords.sample(min(len(valid_coords), 30000), random_state=42).sort_index(),
        y="latitude",
        title="GPRMC: Zmiana szerokości geograficznej (Latitude)",
        labels={"index": "Indeks", "latitude": "Szerokość [°N]"}
    )
    fig_lat.update_traces(marker=dict(size=3, color="#60a5fa"))
    fig_lat.update_layout(template="plotly_dark")
    save_html_plot(fig_lat, "gprmc_latitude_points.html")

    # 3. Długość geograficzna w czasie (punkty)
    fig_lon = px.scatter(
        valid_coords.sample(min(len(valid_coords), 30000), random_state=42).sort_index(),
        y="longitude",
        title="GPRMC: Zmiana długości geograficznej (Longitude)",
        labels={"index": "Indeks", "longitude": "Długość [°E]"}
    )
    fig_lon.update_traces(marker=dict(size=3, color="#c084fc"))
    fig_lon.update_layout(template="plotly_dark")
    save_html_plot(fig_lon, "gprmc_longitude_points.html")

    # 4. Status (A / V)
    stat_counts = df["status"].fillna("Brak").value_counts().reset_index()
    stat_counts.columns = ["status", "count"]
    fig_stat = px.bar(stat_counts, x="status", y="count", title="GPRMC: Status odbiornika (A/V)", color="status")
    fig_stat.update_layout(template="plotly_dark")
    save_html_plot(fig_stat, "gprmc_status.html")

    # 5. Histogram prędkości w węzłach
    speeds = df["speed_knots"].dropna()
    fig_spd = px.histogram(speeds[speeds > 0.5], nbins=60, title="GPRMC: Histogram prędkości (Speed Knots > 0.5)")
    fig_spd.update_layout(template="plotly_dark", xaxis_title="Prędkość [knots]", yaxis_title="Liczba próbek")
    save_html_plot(fig_spd, "gprmc_speed_knots_hist.html")

    # 6. Histogram kursu
    courses = df["course"].dropna()
    fig_crs = px.histogram(courses, nbins=72, range_x=[0, 360], title="GPRMC: Histogram kursu (Course 0-360°)")
    fig_crs.update_layout(template="plotly_dark", xaxis_title="Kurs [°]", yaxis_title="Liczba próbek")
    save_html_plot(fig_crs, "gprmc_course_hist.html")

    # 7. Mode
    m_counts = df["mode"].fillna("Brak").value_counts().reset_index()
    m_counts.columns = ["mode", "count"]
    fig_mode = px.bar(m_counts, x="mode", y="count", title="GPRMC: Tryb pracy odbiornika (Mode)", color="mode")
    fig_mode.update_layout(template="plotly_dark")
    save_html_plot(fig_mode, "gprmc_mode.html")

    # 8. Hemisfery (Latitude i Longitude)
    for col, name in [("latitude_hemisphere", "Szerokość"), ("longitude_hemisphere", "Długość")]:
        h_counts = df[col].fillna("Brak").value_counts().reset_index()
        h_counts.columns = ["hemisphere", "count"]
        fig_hem = px.bar(h_counts, x="hemisphere", y="count", title=f"GPRMC: Hemisfera - {name}", color="hemisphere")
        fig_hem.update_layout(template="plotly_dark")
        save_html_plot(fig_hem, f"gprmc_{col}.html")


# =====================================================================
# 3. GPGSA
# =====================================================================
def plot_gpgsa(df: pd.DataFrame):
    if df.empty:
        return
    print("\n[+] Generowanie wykresów interaktywnych GPGSA...")

    # 1. Mode 1
    m1 = df["mode1"].fillna("Brak").value_counts().reset_index()
    m1.columns = ["mode1", "count"]
    fig_m1 = px.bar(m1, x="mode1", y="count", title="GPGSA: Mode 1 (M=Manual, A=Automatic)", color="mode1")
    fig_m1.update_layout(template="plotly_dark")
    save_html_plot(fig_m1, "gpgsa_mode1.html")

    # 2. Mode 2
    m2 = df["mode2"].astype(str).value_counts().reset_index()
    m2.columns = ["mode2", "count"]
    fig_m2 = px.bar(m2, x="mode2", y="count", title="GPGSA: Mode 2 (1=No Fix, 2=2D, 3=3D)", color="mode2")
    fig_m2.update_layout(template="plotly_dark")
    save_html_plot(fig_m2, "gpgsa_mode2.html")

    # 3. Boxplot PDOP, HDOP, VDOP
    dop_clean = df[["pdop", "hdop", "vdop"]].dropna()
    dop_clean = dop_clean[(dop_clean["pdop"] < 20) & (dop_clean["hdop"] < 20)]
    fig_dop = go.Figure()
    for col in ["pdop", "hdop", "vdop"]:
        fig_dop.add_trace(go.Box(y=dop_clean[col], name=col.upper()))
    fig_dop.update_layout(title="GPGSA: Rozkład współczynników geometrycznych precyzji (DOP)", template="plotly_dark")
    save_html_plot(fig_dop, "gpgsa_dop_boxplot.html")

    # 4. Liczba satelitów w slotach 1-12
    sat_cols = [f"satellite_{i}" for i in range(1, 13) if f"satellite_{i}" in df.columns]
    if sat_cols:
        sats_count = df[sat_cols].notna().sum(axis=1)
        fig_sc = px.histogram(sats_count, nbins=13, title="GPGSA: Liczba satelitów w rozwiązaniu (sloty 1-12)")
        fig_sc.update_layout(template="plotly_dark", xaxis_title="Liczba satelitów", yaxis_title="Liczba epok")
        save_html_plot(fig_sc, "gpgsa_satellites_used_count.html")


# =====================================================================
# 4. GPVTG
# =====================================================================
def plot_gpvtg(df: pd.DataFrame):
    if df.empty:
        return
    print("\n[+] Generowanie wykresów interaktywnych GPVTG...")

    # 1. Speed Knots
    sk = df["speed_knots"].dropna()
    fig_sk = px.histogram(sk[sk > 0.5], nbins=50, title="GPVTG: Rozkład prędkości w węzłach (Speed Knots)")
    fig_sk.update_layout(template="plotly_dark", xaxis_title="Speed [knots]", yaxis_title="Liczebność")
    save_html_plot(fig_sk, "gpvtg_speed_knots_hist.html")

    # 2. Speed KM/H
    skm = df["speed_kmh"].dropna()
    fig_skm = px.histogram(skm[skm > 1.0], nbins=50, title="GPVTG: Rozkład prędkości drogowej (Speed KM/H)")
    fig_skm.update_layout(template="plotly_dark", xaxis_title="Speed [km/h]", yaxis_title="Liczebność")
    save_html_plot(fig_skm, "gpvtg_speed_kmh_hist.html")

    # 3. Kurs True
    ct = df["course_true"].dropna()
    fig_ct = px.histogram(ct, nbins=72, range_x=[0, 360], title="GPVTG: Kurs rzeczywisty (Course True)")
    fig_ct.update_layout(template="plotly_dark", xaxis_title="Kurs [°]", yaxis_title="Liczebność")
    save_html_plot(fig_ct, "gpvtg_course_true_hist.html")

    # 4. Kurs Magnetic
    cm = df["course_magnetic"].dropna()
    if not cm.empty:
        fig_cm = px.histogram(cm, nbins=72, range_x=[0, 360], title="GPVTG: Kurs magnetyczny (Course Magnetic)")
    else:
        fig_cm = go.Figure()
        fig_cm.add_annotation(text="Brak danych: Course Magnetic", showarrow=False, font=dict(size=16))
        fig_cm.update_layout(title="GPVTG: Kurs magnetyczny")
    fig_cm.update_layout(template="plotly_dark")
    save_html_plot(fig_cm, "gpvtg_course_magnetic_hist.html")

    # 5. Wskaźniki jednostek i Mode
    for col in ["course_true_indicator", "course_magnetic_indicator", "speed_knots_indicator", "speed_kmh_indicator", "mode"]:
        if col in df.columns:
            vc = df[col].fillna("Brak").value_counts().reset_index()
            vc.columns = [col, "count"]
            fig_ind = px.bar(vc, x=col, y="count", title=f"GPVTG: Wskaźnik {col}", color=col)
            fig_ind.update_layout(template="plotly_dark")
            save_html_plot(fig_ind, f"gpvtg_indicator_{col}.html")


# =====================================================================
# 5. GPGGA
# =====================================================================
def plot_gpgga(df: pd.DataFrame):
    if df.empty:
        return
    print("\n[+] Generowanie wykresów interaktywnych GPGGA...")

    # 1. Fix Quality
    fq = df["fix_quality"].astype(str).value_counts().reset_index()
    fq.columns = ["fix_quality", "count"]
    fig_fq = px.bar(fq, x="fix_quality", y="count", title="GPGGA: Fix Quality (0=Brak, 1=GPS, 2=DGPS)", color="fix_quality")
    fig_fq.update_layout(template="plotly_dark")
    save_html_plot(fig_fq, "gpgga_fix_quality.html")

    # 2. Satellites Used
    su = df["satellites_used"].dropna()
    fig_su = px.histogram(su, nbins=20, title="GPGGA: Satellites Used (Liczba użytych satelitów)")
    fig_su.update_layout(template="plotly_dark", xaxis_title="Satelity", yaxis_title="Liczebność")
    save_html_plot(fig_su, "gpgga_satellites_used.html")

    # 3. HDOP
    hd = df["hdop"].dropna()
    fig_hd = px.histogram(hd[hd < 10], nbins=50, title="GPGGA: Wskaźnik precyzji poziomej HDOP (< 10)")
    fig_hd.update_layout(template="plotly_dark", xaxis_title="HDOP", yaxis_title="Liczebność")
    save_html_plot(fig_hd, "gpgga_hdop.html")

    # 4. Altitude
    alt = df["altitude"].dropna()
    fig_alt = px.histogram(alt, nbins=60, title="GPGGA: Wysokość n.p.m. (Altitude)")
    fig_alt.update_layout(template="plotly_dark", xaxis_title="Wysokość [m]", yaxis_title="Liczebność")
    save_html_plot(fig_alt, "gpgga_altitude_hist.html")

    # 5. Geoid Separation
    if "geoid_separation" in df.columns:
        geo = df["geoid_separation"].dropna()
        if not geo.empty:
            fig_geo = px.histogram(geo, nbins=50, title="GPGGA: Rozdział geoidy (Geoid Separation)")
        else:
            fig_geo = go.Figure()
            fig_geo.add_annotation(text="Brak danych: Geoid Separation", showarrow=False, font=dict(size=16))
            fig_geo.update_layout(title="GPGGA: Geoid Separation")
        fig_geo.update_layout(template="plotly_dark", xaxis_title="Wartość [m]", yaxis_title="Liczebność")
        save_html_plot(fig_geo, "gpgga_geoid_separation.html")

    # 6. Wskaźniki jakościowe
    for col in ["altitude_units", "geoid_separation_units", "dgps_station_id"]:
        if col in df.columns:
            vc = df[col].fillna("Brak").value_counts().reset_index()
            vc.columns = [col, "count"]
            fig_unit = px.bar(vc, x=col, y="count", title=f"GPGGA: Parametr {col}", color=col)
            fig_unit.update_layout(template="plotly_dark")
            save_html_plot(fig_unit, f"gpgga_{col}.html")


# =====================================================================
# 6. GPGSV
# =====================================================================
def plot_gpgsv(conn):
    print("\n[+] Generowanie wykresów interaktywnych GPGSV...")

    # Widoczne satelity
    df_gsv = pd.read_sql("SELECT satellites_in_view FROM gpgsv WHERE satellites_in_view IS NOT NULL LIMIT 250000;", conn)
    if not df_gsv.empty:
        fig_v = px.histogram(df_gsv["satellites_in_view"], nbins=20, title="GPGSV: Liczba satelitów w polu widzenia (In View)")
        fig_v.update_layout(template="plotly_dark", xaxis_title="Liczba satelitów", yaxis_title="Liczebność")
        save_html_plot(fig_v, "gpgsv_satellites_in_view.html")

    # Pobranie szczegółów pojedynczych satelitów
    try:
        query_sats = """
            SELECT 
                (elem->>'prn')::int as prn,
                (elem->>'elevation')::float as elevation,
                (elem->>'azimuth')::float as azimuth,
                (elem->>'snr')::float as snr
            FROM gpgsv,
            jsonb_array_elements(satellites) as elem
            WHERE satellites IS NOT NULL
            LIMIT 50000;
        """
        df_sats = pd.read_sql(query_sats, conn)
    except Exception:
        try:
            df_sats = pd.read_sql("SELECT prn, elevation, azimuth, snr FROM satellite WHERE snr IS NOT NULL LIMIT 50000;", conn)
        except Exception:
            df_sats = pd.DataFrame()

    # Siła sygnału SNR
    if not df_sats.empty and "snr" in df_sats.columns:
        valid_snr = df_sats["snr"].dropna()
        fig_snr = px.histogram(valid_snr[valid_snr > 0], nbins=50, title="GPGSV: Rozkład siły sygnału satelitów SNR (dB-Hz)")
        fig_snr.update_layout(template="plotly_dark", xaxis_title="SNR [dB-Hz]", yaxis_title="Liczebność")
        save_html_plot(fig_snr, "gpgsv_snr_distribution.html")

    # Skyplot biegunowy
    if not df_sats.empty and "elevation" in df_sats.columns and "azimuth" in df_sats.columns:
        s_sats = df_sats.dropna(subset=["elevation", "azimuth"]).sample(min(len(df_sats), 5000), random_state=42)
        fig_sky = px.scatter_polar(
            s_sats,
            r=90.0 - s_sats["elevation"],  # Zenit na środku (90°)
            theta="azimuth",
            color="snr",
            color_continuous_scale="Viridis",
            hover_data=["prn", "elevation", "azimuth", "snr"],
            title="GPGSV: Interaktywny Skyplot Satelitów (Zenit w centrum)"
        )
        fig_sky.update_layout(
            template="plotly_dark",
            polar=dict(
                radialaxis=dict(tickvals=[0, 30, 60, 90], ticktext=["90°", "60°", "30°", "0°"]),
                angularaxis=dict(direction="clockwise", rotation=90)
            )
        )
        save_html_plot(fig_sky, "gpgsv_skyplot_polar.html")


# =====================================================================
# GŁÓWNY START
# =====================================================================
def main():
    print("=" * 60)
    print(" POBIERANIE DANYCH Z BAZY POSTGRESQL ")
    print("=" * 60)

    with psycopg.connect(DB_URL) as conn:
        print("[*] Odczyt tabeli gsensord...")
        df_gsensord = pd.read_sql("SELECT g_x::float, g_y::float, g_z::float FROM gsensord LIMIT 500000;", conn)

        print("[*] Odczyt tabeli gprmc...")
        df_gprmc = pd.read_sql("""
            SELECT status, latitude::float, latitude_hemisphere, longitude::float,
                   longitude_hemisphere, speed_knots::float, course::float, mode
            FROM gprmc LIMIT 500000;
        """, conn)

        print("[*] Odczyt tabeli gpgsa...")
        df_gpgsa = pd.read_sql("""
            SELECT mode1, mode2, satellite_1, satellite_2, satellite_3, satellite_4,
                   satellite_5, satellite_6, satellite_7, satellite_8, satellite_9,
                   satellite_10, satellite_11, satellite_12,
                   pdop::float, hdop::float, vdop::float
            FROM gpgsa LIMIT 500000;
        """, conn)

        print("[*] Odczyt tabeli gpvtg...")
        df_gpvtg = pd.read_sql("""
            SELECT course_true::float, course_true_indicator, course_magnetic::float,
                   course_magnetic_indicator, speed_knots::float, speed_knots_indicator,
                   speed_kmh::float, speed_kmh_indicator, mode
            FROM gpvtg LIMIT 500000;
        """, conn)

        print("[*] Odczyt tabeli gpgga...")
        df_gpgga = pd.read_sql("""
            SELECT fix_quality, satellites_used, hdop::float, altitude::float,
                   altitude_units, geoid_separation::float, geoid_separation_units, dgps_station_id
            FROM gpgga LIMIT 500000;
        """, conn)

        print("\n" + "=" * 60)
        print(f" GENEROWANIE PLIKÓW HTML W: {PLOTS_DIR.resolve()} ")
        print("=" * 60)

        plot_gsensord(df_gsensord)
        plot_gprmc(df_gprmc)
        plot_gpgsa(df_gpgsa)
        plot_gpvtg(df_gpvtg)
        plot_gpgga(df_gpgga)
        plot_gpgsv(conn)

    print("\n" + "=" * 60)
    print(f"ZAKOŃCZONO POMYŚLNIE! Wszystkie pliki .html znajdują się w: {PLOTS_DIR.resolve()}")
    print("=" * 60)


if __name__ == "__main__":
    main()