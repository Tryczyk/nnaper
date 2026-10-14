import psycopg
import pandas as pd
import numpy as np
import plotly.express as px
import plotly.graph_objects as go

from constants import DB_URL, PLOTS_DIR


def save_html_plot(fig: go.Figure, filename: str):
    out_path = PLOTS_DIR / filename
    fig.write_html(str(out_path), include_plotlyjs="cdn")
    print(f"  -> Zapisano interaktywny wykres: {filename}")


def plot_gsensord(df: pd.DataFrame):
    if df.empty:
        return

    sample_df = df.sort_index()
    sample_df["g_mag"] = np.sqrt(sample_df["g_x"] ** 2 + sample_df["g_y"] ** 2 + sample_df["g_z"] ** 2)

    fig_3d = px.scatter_3d(
        sample_df,
        x="g_x",
        y="g_y",
        z="g_z",
        color="g_mag",
        color_continuous_scale="Plasma",
        opacity=0.6,
        title="GSENSORD: Przestrzenny rozkład przeciążeń 3D",
    )
    fig_3d.update_traces(marker=dict(size=2.5))
    fig_3d.update_layout(template="plotly_dark")
    save_html_plot(fig_3d, "epochs_gsensord_3d_scatter.html")


def plot_satellites(df: pd.DataFrame):
    if df.empty:
        return

    samples = df.dropna(subset=["elevation", "azimuth"])
    if samples.empty:
        return
    fig = px.scatter_polar(
        samples,
        r=90.0 - samples["elevation"],
        theta="azimuth",
        hover_data=["prn", "elevation", "azimuth"],
        title="Satelity: Skyplot (Zenit w centrum)",
    )
    fig.update_layout(
        template="plotly_dark",
        polar=dict(
            radialaxis=dict(tickvals=[0, 30, 60, 90], ticktext=["90°", "60°", "30°", "0°"]),
            angularaxis=dict(direction="clockwise", rotation=90),
        ),
    )
    save_html_plot(fig, "satellites_skyplot_polar.html")


def main():
    print("=" * 60)
    print(" POBIERANIE DANYCH Z BAZY POSTGRESQL ")
    print("=" * 60)

    with psycopg.connect(DB_URL) as conn:
        epochs = pd.read_sql(
            "SELECT g_x::float, g_y::float, g_z::float FROM epochs;",
            conn,
        )
        satellites = pd.read_sql(
            "SELECT prn, elevation, azimuth FROM satellite;",
            conn,
        )

        print(f" GENEROWANIE PLIKÓW HTML W: {PLOTS_DIR.resolve()} ")
        plot_gsensord(epochs.dropna(subset=["g_x", "g_y", "g_z"]))
        plot_satellites(satellites)


if __name__ == "__main__":
    main()
