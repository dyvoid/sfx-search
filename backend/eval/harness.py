"""Evaluation harness for measuring retrieval quality across queries and config variants."""

from __future__ import annotations

import fnmatch
import json
import math
import re
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from ..config import Config
from ..embed import EmbedderProtocol
from ..scan import normalize_path
from ..search import SearchEngine, SearchHit, SearchMode
from ..store import SfxStore


@dataclass
class EvalQuery:
    id: str
    query: str
    relevant: list[str]
    notes: str = ""
    mode: SearchMode | None = None


@dataclass
class QueryEvalResult:
    query_id: str
    query: str
    relevant_total_in_db: int
    recall_at_10: float
    recall_at_50: float
    mrr: float
    ndcg_at_20: float
    first_relevant_rank: int | None
    top_misses: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class VariantEvalSummary:
    variant_name: str
    mean_recall_at_10: float
    mean_recall_at_50: float
    mean_mrr: float
    mean_ndcg_at_20: float
    query_results: list[QueryEvalResult]


def load_eval_queries(yaml_path: str | Path) -> list[EvalQuery]:
    p = Path(yaml_path)
    raw = yaml.safe_load(p.read_text(encoding="utf-8"))
    if isinstance(raw, dict) and "queries" in raw:
        items = raw["queries"]
    elif isinstance(raw, list):
        items = raw
    else:
        raise ValueError(f"Expected a list of queries in {yaml_path}")

    queries: list[EvalQuery] = []
    for item in items:
        queries.append(
            EvalQuery(
                id=str(item["id"]),
                query=str(item["query"]),
                relevant=[str(r).replace("\\", "/") for r in (item.get("relevant") or [])],
                notes=str(item.get("notes") or ""),
                mode=item.get("mode"),
            )
        )
    return queries


def _glob_to_regex(pattern: str) -> re.Pattern[str]:
    norm_pat = pattern.replace("\\", "/").lower()
    parts = norm_pat.split("**")
    regex_parts = [fnmatch.translate(part).removesuffix(r"\Z").removesuffix("$") for part in parts]
    joined = ".*".join(regex_parts) + r"\Z"
    return re.compile(joined, re.IGNORECASE)


def path_matches_pattern(path: str, pattern: str) -> bool:
    norm_p = normalize_path(path).lower()
    norm_pat = pattern.replace("\\", "/").lower()
    if "*" not in norm_pat and "?" not in norm_pat and "[" not in norm_pat:
        if norm_p == norm_pat or norm_p.endswith("/" + norm_pat.lstrip("/")):
            return True
    rx = _glob_to_regex(norm_pat)
    if rx.match(norm_p):
        return True
    if not norm_pat.startswith("*") and not norm_pat.startswith("/") and ":" not in norm_pat:
        rx_rel = _glob_to_regex("**/" + norm_pat)
        if rx_rel.match(norm_p):
            return True
    return False


def is_relevant_path(path: str, patterns: Sequence[str]) -> bool:
    return any(path_matches_pattern(path, pat) for pat in patterns)


def compute_metrics(
    ranked_paths: Sequence[str],
    relevant_patterns: Sequence[str],
    all_library_paths: Sequence[str] | None = None,
) -> tuple[float, float, float, float, int | None, int]:
    rel_flags = [is_relevant_path(p, relevant_patterns) for p in ranked_paths]

    if all_library_paths is not None:
        total_rel = sum(1 for p in all_library_paths if is_relevant_path(p, relevant_patterns))
    else:
        total_rel = sum(1 for flag in rel_flags if flag)
    denom = max(1, total_rel)

    hits_10 = sum(1 for flag in rel_flags[:10] if flag)
    hits_50 = sum(1 for flag in rel_flags[:50] if flag)
    recall_10 = min(1.0, float(hits_10) / float(denom))
    recall_50 = min(1.0, float(hits_50) / float(denom))

    first_rank: int | None = None
    mrr = 0.0
    for idx, flag in enumerate(rel_flags, start=1):
        if flag:
            first_rank = idx
            mrr = 1.0 / float(idx)
            break

    dcg_20 = 0.0
    for idx, flag in enumerate(rel_flags[:20], start=1):
        if flag:
            dcg_20 += 1.0 / math.log2(idx + 1.0)

    ideal_count = min(20, denom)
    idcg_20 = sum(1.0 / math.log2(idx + 1.0) for idx in range(1, ideal_count + 1))
    ndcg_20 = (dcg_20 / idcg_20) if idcg_20 > 0 else 0.0

    return (
        round(recall_10, 4),
        round(recall_50, 4),
        round(mrr, 4),
        round(ndcg_20, 4),
        first_rank,
        total_rel,
    )


def evaluate_queries(
    config: Config,
    store: SfxStore,
    queries: Sequence[EvalQuery],
    embedder: EmbedderProtocol | None = None,
    variant_name: str = "default",
    default_mode: SearchMode = "hybrid",
    recall_miss_threshold: float = 0.5,
) -> VariantEvalSummary:
    engine = SearchEngine(config=config, store=store, embedder=embedder)

    all_paths: list[str] = []
    if "files" in store.table_names():
        tbl = store.db.open_table("files")
        total = tbl.count_rows()
        if total > 0:
            rows = tbl.search().where("status = 'ok'").select(["path"]).limit(total + 100).to_list()
            all_paths = [str(r["path"]) for r in rows]

    q_results: list[QueryEvalResult] = []
    for eq in queries:
        mode: SearchMode = eq.mode or default_mode
        hits: list[SearchHit] = engine.search(query=eq.query, k=50, mode=mode)
        ranked_paths = [h.path for h in hits]

        r10, r50, mrr, ndcg20, first_rank, total_rel = compute_metrics(
            ranked_paths=ranked_paths,
            relevant_patterns=eq.relevant,
            all_library_paths=all_paths if all_paths else None,
        )

        misses: list[dict[str, Any]] = []
        if r10 < recall_miss_threshold:
            for rank_i, h in enumerate(hits[:10], start=1):
                misses.append(
                    {
                        "rank": rank_i,
                        "path": h.path,
                        "relevant": is_relevant_path(h.path, eq.relevant),
                        "rrf_score": round(h.rrf_score, 5),
                        "clap_score": round(h.clap_score, 4) if h.clap_score is not None else None,
                        "bm25_score": round(h.bm25_score, 4) if h.bm25_score is not None else None,
                        "best_offset_s": round(h.best_offset_s, 2),
                    }
                )

        q_results.append(
            QueryEvalResult(
                query_id=eq.id,
                query=eq.query,
                relevant_total_in_db=total_rel,
                recall_at_10=r10,
                recall_at_50=r50,
                mrr=mrr,
                ndcg_at_20=ndcg20,
                first_relevant_rank=first_rank,
                top_misses=misses,
            )
        )

    n = max(1, len(q_results))
    return VariantEvalSummary(
        variant_name=variant_name,
        mean_recall_at_10=round(sum(r.recall_at_10 for r in q_results) / n, 4),
        mean_recall_at_50=round(sum(r.recall_at_50 for r in q_results) / n, 4),
        mean_mrr=round(sum(r.mrr for r in q_results) / n, 4),
        mean_ndcg_at_20=round(sum(r.ndcg_at_20 for r in q_results) / n, 4),
        query_results=q_results,
    )


def format_eval_markdown(
    summaries: Sequence[VariantEvalSummary],
    show_misses: bool = False,
) -> str:
    lines: list[str] = []
    lines.append("# Evaluation Results")
    lines.append("")
    lines.append("## Summary by Variant")
    lines.append("")
    lines.append("| Variant | Recall@10 | Recall@50 | MRR | nDCG@20 |")
    lines.append("|---|---:|---:|---:|---:|")
    for s in summaries:
        lines.append(
            f"| `{s.variant_name}` | {s.mean_recall_at_10:.4f} | {s.mean_recall_at_50:.4f} | "
            f"{s.mean_mrr:.4f} | {s.mean_ndcg_at_20:.4f} |"
        )
    lines.append("")

    for s in summaries:
        lines.append(f"## Per-Query Breakdown: `{s.variant_name}`")
        lines.append("")
        lines.append(
            "| Query ID | Query | Rel in DB | First Rank | Recall@10 | Recall@50 | MRR | nDCG@20 |"
        )
        lines.append("|---|---|---:|---:|---:|---:|---:|---:|")
        for qr in s.query_results:
            fr = str(qr.first_relevant_rank) if qr.first_relevant_rank is not None else "-"
            lines.append(
                f"| `{qr.query_id}` | {qr.query} | {qr.relevant_total_in_db} | {fr} | "
                f"{qr.recall_at_10:.4f} | {qr.recall_at_50:.4f} | {qr.mrr:.4f} | {qr.ndcg_at_20:.4f} |"
            )
        lines.append("")

        if show_misses:
            miss_queries = [qr for qr in s.query_results if qr.top_misses]
            if miss_queries:
                lines.append(f"### Top Results for Low-Recall Queries (`{s.variant_name}`)")
                lines.append("")
                for qr in miss_queries:
                    lines.append(
                        f'#### `{qr.query_id}`: "{qr.query}" (Recall@10 = {qr.recall_at_10:.2f})'
                    )
                    for m in qr.top_misses:
                        mark = "[REL]" if m["relevant"] else "[MISS]"
                        lines.append(
                            f"- #{m['rank']} {mark} `{m['path']}` "
                            f"(rrf={m['rrf_score']}, clap={m['clap_score']}, bm25={m['bm25_score']}, offset={m['best_offset_s']}s)"
                        )
                    lines.append("")

    return "\n".join(lines)


def save_eval_run(
    summaries: Sequence[VariantEvalSummary],
    output_dir: str | Path = "eval/runs",
    show_misses: bool = False,
) -> tuple[Path, Path]:
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
    md_path = out_dir / f"eval_{ts}.md"
    json_path = out_dir / f"eval_{ts}.json"

    md_text = format_eval_markdown(summaries, show_misses=show_misses)
    md_path.write_text(md_text, encoding="utf-8")

    payload = {
        "timestamp_utc": ts,
        "variants": [asdict(s) for s in summaries],
    }
    json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return md_path, json_path
