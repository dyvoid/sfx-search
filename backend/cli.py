"""Typer CLI entry points for sfx-search."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Annotated, Any, Literal

import typer
from rich.console import Console
from rich.table import Table

from .config import Config, load_config
from .embed import ClapEmbedder
from .eval.harness import (
    VariantEvalSummary,
    evaluate_queries,
    format_eval_markdown,
    load_eval_queries,
    save_eval_run,
)
from .indexer import IndexStats, run_indexer
from .search import SearchEngine, SearchHit, SearchMode
from .store import ModelMismatchError, SearchFilters, SfxStore

app = typer.Typer(
    name="sfxsearch",
    help="Local semantic and hybrid search engine for sound-effects libraries.",
    add_completion=False,
)
console = Console()


def _resolve_config(
    config_file: Path | None,
    model: str | None = None,
    fp16: bool | None = None,
) -> Config:
    cfg = load_config(config_file)
    if model is not None:
        cfg.embedding.model_id = model
    if fp16 is not None:
        cfg.embedding.precision = "fp16" if fp16 else "fp32"
    return cfg


@app.command("index")
def cmd_index(
    roots: Annotated[
        list[Path] | None,
        typer.Argument(help="Library root folder(s) to scan. Defaults to config.toml roots."),
    ] = None,
    limit: Annotated[
        int | None,
        typer.Option("--limit", help="Maximum number of files to scan."),
    ] = None,
    reindex: Annotated[
        bool,
        typer.Option("--reindex", help="Re-index all scanned files even if unchanged."),
    ] = False,
    model: Annotated[
        str | None,
        typer.Option("--model", help="Override CLAP embedding model ID."),
    ] = None,
    fp16: Annotated[
        bool | None,
        typer.Option("--fp16/--fp32", help="Use fp16 or fp32 precision on GPU."),
    ] = None,
    config_file: Annotated[
        Path | None,
        typer.Option("--config", "-c", help="Path to config.toml."),
    ] = None,
) -> None:
    """Index one or more sound library roots into LanceDB."""
    cfg = _resolve_config(config_file, model=model, fp16=fp16)
    target_roots = [str(p) for p in roots] if roots else cfg.library.roots
    store = SfxStore(cfg.db_dir)

    model_mismatch = False
    try:
        stored_model, _ = store.get_stored_model_info()
        if stored_model and stored_model != cfg.embedding.model_id:
            model_mismatch = True
            if not reindex:
                console.print(
                    f"[bold red]Model mismatch:[/bold red] Database uses '{stored_model}', "
                    f"but '{cfg.embedding.model_id}' was requested. "
                    "Refusing to mix models in one database. Pass --reindex to rebuild or use a separate data_dir."
                )
                raise typer.Exit(code=1)
    except ModelMismatchError as exc:
        console.print(f"[bold red]{exc}[/bold red]")
        raise typer.Exit(code=1) from exc

    console.print(
        f"[cyan]Loading embedder[/cyan] [bold]{cfg.embedding.model_id}[/bold] "
        f"({cfg.embedding.precision})..."
    )
    # Load the new embedder before dropping tables so a bad --model can't
    # destroy an existing index.
    embedder = ClapEmbedder(
        model_id=cfg.embedding.model_id,
        precision=cfg.embedding.precision,
        window_s=cfg.embedding.window_s,
        hop_s=cfg.embedding.hop_s,
        max_chunks_per_file=cfg.embedding.max_chunks_per_file,
        batch_size=cfg.embedding.batch_size,
    )

    if model_mismatch and reindex:
        try:
            store.db.drop_table("files")
            if "chunks" in store.table_names():
                store.db.drop_table("chunks")
        except Exception as exc:
            console.print(f"[bold red]Failed to reset the existing index:[/bold red] {exc}")
            raise typer.Exit(code=1) from exc

    last_reported = 0

    def _on_progress(st: IndexStats) -> None:
        nonlocal last_reported
        done = st.indexed_ok + st.indexed_errors
        if done == 0 or (done - last_reported < 10 and done < st.to_index_count):
            return
        last_reported = done
        rem = max(0, st.to_index_count - done)
        eta_s = (rem / (st.files_per_min / 60.0)) if st.files_per_min > 0 else 0.0
        console.print(
            f"  [{done}/{st.to_index_count}] "
            f"{st.files_per_min:.1f} files/min | "
            f"{st.audio_hours_per_min:.2f} audio-hrs/min ({st.audio_hours_per_hour:.1f}x realtime) | "
            f"errors: {st.indexed_errors} | "
            f"VRAM: {st.gpu_memory_mb:.0f} MB | "
            f"ETA: {eta_s:.0f}s"
        )

    try:
        stats = run_indexer(
            config=cfg,
            store=store,
            embedder=embedder,
            roots=target_roots,
            limit=limit,
            reindex=reindex,
            progress_callback=_on_progress,
        )
    except ModelMismatchError as exc:
        console.print(f"[bold red]{exc}[/bold red]")
        raise typer.Exit(code=1) from exc

    console.print(
        f"\n[bold green]Index run complete[/bold green] in {stats.elapsed_seconds:.2f}s:\n"
        f"  Scanned: {stats.scanned_count} | Unchanged: {stats.skipped_unchanged} | "
        f"Indexed OK: {stats.indexed_ok} | Errors: {stats.indexed_errors} | Missing: {stats.marked_missing}\n"
        f"  Chunks: {stats.total_chunks} | Audio: {stats.total_audio_seconds / 60.0:.2f} min\n"
        f"  Throughput: {stats.files_per_min:.1f} files/min | "
        f"{stats.audio_hours_per_min:.3f} audio-hours/min ({stats.audio_hours_per_hour:.1f} audio-hours/hour)\n"
        f"  Peak GPU VRAM: {stats.gpu_memory_mb:.1f} MB"
    )


@app.command("search")
def cmd_search(
    query: Annotated[str, typer.Argument(help="Search query text.")],
    k: Annotated[int, typer.Option("-k", "--top-k", help="Number of results to return.")] = 20,
    mode: Annotated[
        SearchMode,
        typer.Option("--mode", "-m", help="Search mode: hybrid, audio_only, keyword_only."),
    ] = "hybrid",
    min_dur: Annotated[
        float | None,
        typer.Option("--min-dur", help="Minimum duration in seconds."),
    ] = None,
    max_dur: Annotated[
        float | None,
        typer.Option("--max-dur", help="Maximum duration in seconds."),
    ] = None,
    min_lufs: Annotated[
        float | None,
        typer.Option("--min-lufs", help="Minimum integrated LUFS."),
    ] = None,
    max_lufs: Annotated[
        float | None,
        typer.Option("--max-lufs", help="Maximum integrated LUFS."),
    ] = None,
    format_filter: Annotated[
        str | None,
        typer.Option("--format", help="Filter by audio format/extension."),
    ] = None,
    root_filter: Annotated[
        str | None,
        typer.Option("--root", help="Filter by library root folder."),
    ] = None,
    favorites: Annotated[
        bool,
        typer.Option("--favorites", help="Only return favorited sounds."),
    ] = False,
    min_loop: Annotated[
        float | None,
        typer.Option("--min-loop", help="Minimum loop score [0..1]."),
    ] = None,
    as_json: Annotated[
        bool,
        typer.Option("--json", help="Print results as JSON."),
    ] = False,
    config_file: Annotated[
        Path | None,
        typer.Option("--config", "-c", help="Path to config.toml."),
    ] = None,
) -> None:
    """Search the indexed sound library."""
    cfg = _resolve_config(config_file)
    store = SfxStore(cfg.db_dir)
    engine = SearchEngine(config=cfg, store=store)

    filters = SearchFilters(
        min_duration=min_dur,
        max_duration=max_dur,
        min_lufs=min_lufs,
        max_lufs=max_lufs,
        formats=[format_filter] if format_filter else None,
        roots=[root_filter] if root_filter else None,
        favorites_only=favorites,
        min_loop_score=min_loop,
    )
    try:
        hits = engine.search(query=query, k=k, mode=mode, filters=filters)
    except ModelMismatchError as exc:
        console.print(f"[bold red]{exc}[/bold red]")
        raise typer.Exit(code=1) from exc

    if as_json:
        sys.stdout.write(
            json.dumps([h.to_dict() for h in hits], indent=2, ensure_ascii=False) + "\n"
        )
        return

    _render_hits_table(hits, title=f"Search: '{query}' ({mode})")


@app.command("similar")
def cmd_similar(
    target: Annotated[str, typer.Argument(help="Reference file path or file_id.")],
    k: Annotated[int, typer.Option("-k", "--top-k", help="Number of results to return.")] = 20,
    chunk: Annotated[
        int | None,
        typer.Option("--chunk", help="Optional chunk index for moment similarity."),
    ] = None,
    as_json: Annotated[
        bool,
        typer.Option("--json", help="Print results as JSON."),
    ] = False,
    config_file: Annotated[
        Path | None,
        typer.Option("--config", "-c", help="Path to config.toml."),
    ] = None,
) -> None:
    """Find sounds similar to an indexed file_id or an external audio file."""
    cfg = _resolve_config(config_file)
    store = SfxStore(cfg.db_dir)
    engine = SearchEngine(config=cfg, store=store)

    try:
        hits = engine.find_similar(file_id_or_path=target, k=k, chunk_idx=chunk)
    except (ModelMismatchError, ValueError, FileNotFoundError) as exc:
        console.print(f"[bold red]{exc}[/bold red]")
        raise typer.Exit(code=1) from exc
    if as_json:
        sys.stdout.write(
            json.dumps([h.to_dict() for h in hits], indent=2, ensure_ascii=False) + "\n"
        )
        return

    _render_hits_table(hits, title=f"Similar to: {target}")


@app.command("serve")
def cmd_serve(
    host: Annotated[str | None, typer.Option("--host", help="Bind host.")] = None,
    port: Annotated[int | None, typer.Option("--port", help="Bind port.")] = None,
    mcp_only: Annotated[
        bool,
        typer.Option("--mcp", help="Run the MCP server instead of the HTTP API."),
    ] = False,
    mcp_transport: Annotated[
        Literal["stdio", "sse", "streamable-http"],
        typer.Option("--mcp-transport", help="MCP transport when --mcp is set."),
    ] = "stdio",
    config_file: Annotated[
        Path | None,
        typer.Option("--config", "-c", help="Path to config.toml."),
    ] = None,
    open_browser: Annotated[
        bool,
        typer.Option(
            "--open/--no-open",
            help="Open the web UI in the default browser once the server answers.",
        ),
    ] = False,
) -> None:
    """Start the FastAPI web server (or MCP server with --mcp)."""
    import uvicorn

    from .api import create_app
    from .mcp_server import run_mcp_server

    cfg = _resolve_config(config_file)
    bind_host = host or cfg.server.host
    bind_port = port or cfg.server.port

    if mcp_only:
        run_mcp_server(transport=mcp_transport, host=bind_host, port=bind_port, config=cfg)
        return

    if open_browser:
        _open_browser_when_ready(bind_host, bind_port)

    fastapi_app = create_app(config=cfg)
    console.print(
        f"[bold green]Starting sfx-search server on http://{bind_host}:{bind_port}[/bold green]"
    )
    uvicorn.run(fastapi_app, host=bind_host, port=bind_port, log_level="info")


def _open_browser_when_ready(host: str, port: int) -> None:
    """Open the web UI in the default browser once the server answers."""
    import threading
    import time
    import urllib.error
    import urllib.request
    import webbrowser

    display_host = host if host not in ("0.0.0.0", "::", "") else "127.0.0.1"
    url = f"http://{display_host}:{port}"

    def wait_and_open() -> None:
        deadline = time.monotonic() + 120.0
        while time.monotonic() < deadline:
            try:
                urllib.request.urlopen(f"{url}/api/library", timeout=2)
                break
            except urllib.error.HTTPError:
                # Server is up even if the endpoint itself errored.
                break
            except OSError:
                time.sleep(0.25)
        else:
            console.print(
                f"[yellow]Timed out waiting for the server; open {url} manually.[/yellow]"
            )
            return
        webbrowser.open(url)

    threading.Thread(target=wait_and_open, daemon=True).start()


@app.command("eval")
def cmd_eval(
    queries_file: Annotated[
        Path,
        typer.Argument(help="Path to queries.yaml evaluation file."),
    ],
    config_variant: Annotated[
        list[str] | None,
        typer.Option(
            "--config-variant", "-v", help="Named variant(s) or built-in mode variants to compare."
        ),
    ] = None,
    show_misses: Annotated[
        bool,
        typer.Option("--show-misses", help="List top results for queries below recall threshold."),
    ] = False,
    recall_threshold: Annotated[
        float,
        typer.Option("--recall-threshold", help="Recall@10 threshold for --show-misses."),
    ] = 0.5,
    config_file: Annotated[
        Path | None,
        typer.Option("--config", "-c", help="Path to config.toml."),
    ] = None,
) -> None:
    """Run the evaluation harness on a YAML query set."""
    cfg = _resolve_config(config_file)
    store = SfxStore(cfg.db_dir)
    queries = load_eval_queries(queries_file)

    # Lazy + shared: one ClapEmbedder across all variants; never loaded for
    # keyword_only-only runs.
    class _LazyEmbedder:
        def __init__(self, c: Config) -> None:
            self._cfg = c
            self._inner: ClapEmbedder | None = None

        def _get(self) -> ClapEmbedder:
            if self._inner is None:
                self._inner = ClapEmbedder(
                    model_id=self._cfg.embedding.model_id,
                    precision=self._cfg.embedding.precision,
                    window_s=self._cfg.embedding.window_s,
                    hop_s=self._cfg.embedding.hop_s,
                    max_chunks_per_file=self._cfg.embedding.max_chunks_per_file,
                    batch_size=self._cfg.embedding.batch_size,
                )
            return self._inner

        @property
        def model_id(self) -> str:
            return self._inner.model_id if self._inner else self._cfg.embedding.model_id

        def __getattr__(self, name: str) -> Any:
            return getattr(self._get(), name)

    embedder = _LazyEmbedder(cfg)

    builtin_modes: dict[str, SearchMode] = {
        "hybrid": "hybrid",
        "audio_only": "audio_only",
        "keyword_only": "keyword_only",
    }

    variant_names = config_variant if config_variant else ["hybrid", "audio_only", "keyword_only"]
    summaries: list[VariantEvalSummary] = []

    for vname in variant_names:
        if vname in builtin_modes:
            summary = evaluate_queries(
                config=cfg,
                store=store,
                queries=queries,
                embedder=embedder,
                variant_name=vname,
                default_mode=builtin_modes[vname],
                recall_miss_threshold=recall_threshold,
            )
        elif vname in cfg.variants:
            v_cfg = cfg.apply_variant(vname)
            v_mode: SearchMode = cfg.variants[vname].get("mode", "hybrid")
            summary = evaluate_queries(
                config=v_cfg,
                store=store,
                queries=queries,
                embedder=embedder,
                variant_name=vname,
                default_mode=v_mode,
                recall_miss_threshold=recall_threshold,
            )
        else:
            console.print(
                f"[yellow]Unknown variant '{vname}', running with default hybrid config.[/yellow]"
            )
            summary = evaluate_queries(
                config=cfg,
                store=store,
                queries=queries,
                embedder=embedder,
                variant_name=vname,
                default_mode="hybrid",
                recall_miss_threshold=recall_threshold,
            )
        summaries.append(summary)

    md_path, json_path = save_eval_run(summaries, output_dir="eval/runs", show_misses=show_misses)
    console.print(format_eval_markdown(summaries, show_misses=show_misses))
    console.print(f"\n[green]Saved evaluation report to:[/green] {md_path} and {json_path}")


@app.command("stats")
def cmd_stats(
    as_json: Annotated[
        bool,
        typer.Option("--json", help="Print stats as JSON."),
    ] = False,
    config_file: Annotated[
        Path | None,
        typer.Option("--config", "-c", help="Path to config.toml."),
    ] = None,
) -> None:
    """Display library statistics, model info, and index counts."""
    cfg = _resolve_config(config_file)
    store = SfxStore(cfg.db_dir)
    stats = store.get_library_stats()

    if as_json:
        sys.stdout.write(json.dumps(stats, indent=2, ensure_ascii=False) + "\n")
        return

    table = Table(title="sfx-search Library Statistics")
    table.add_column("Metric", style="cyan")
    table.add_column("Value", style="white")
    table.add_row("Database path", str(cfg.db_dir))
    table.add_row("Embedding model", str(stats["embedding_model"] or cfg.embedding.model_id))
    table.add_row("Embedding dimension", str(stats["embedding_dim"] or 512))
    table.add_row("Total files", str(stats["total_files"]))
    table.add_row("OK files", str(stats["ok_files"]))
    table.add_row("Error files", str(stats["error_files"]))
    table.add_row("Missing files", str(stats["missing_files"]))
    table.add_row("Total chunks", str(stats["total_chunks"]))
    table.add_row(
        "Total audio duration",
        f"{stats['total_duration_s']:.1f} s ({stats['total_duration_hours']:.2f} hours)",
    )
    table.add_row("Total size", f"{stats['total_size_bytes'] / (1024 * 1024):.2f} MB")
    table.add_row("Favorites", str(stats["favorites_count"]))
    table.add_row("Roots", ", ".join(stats["roots"]) or "-")
    table.add_row(
        "Formats",
        ", ".join(f"{k}: {v}" for k, v in sorted(stats["formats"].items())) or "-",
    )
    console.print(table)


def _render_hits_table(hits: list[SearchHit], title: str) -> None:
    if not hits:
        console.print("[yellow]No results found.[/yellow]")
        return

    table = Table(title=title)
    table.add_column("#", justify="right", style="dim")
    table.add_column("File", style="bold white")
    table.add_column("Dur (s)", justify="right")
    table.add_column("Offset (s)", justify="right", style="cyan")
    table.add_column("RRF", justify="right", style="green")
    table.add_column("CLAP", justify="right")
    table.add_column("BM25", justify="right")
    table.add_column("LUFS", justify="right")
    table.add_column("Loop", justify="right")
    table.add_column("Path", style="dim")

    for idx, h in enumerate(hits, start=1):
        clap_s = f"{h.clap_score:.3f}" if h.clap_score is not None else "-"
        bm25_s = f"{h.bm25_score:.2f}" if h.bm25_score is not None else "-"
        lufs_s = f"{h.lufs_integrated:.1f}" if h.lufs_integrated is not None else "-"
        loop_s = f"{h.loop_score:.2f}" if h.loop_score is not None else "-"
        fav = "* " if h.favorite else ""
        table.add_row(
            str(idx),
            f"{fav}{h.filename}",
            f"{h.duration_s:.2f}",
            f"{h.best_offset_s:.1f}",
            f"{h.rrf_score:.4f}",
            clap_s,
            bm25_s,
            lufs_s,
            loop_s,
            h.path,
        )
    console.print(table)


if __name__ == "__main__":
    app()
