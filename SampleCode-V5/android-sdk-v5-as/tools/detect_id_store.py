#!/usr/bin/env python3
"""Descriptor store inspection utilities for /realtime/detect_id.

Usage
  python tools/detect_id_store.py list [--limit 20]
  python tools/detect_id_store.py show <instance_id>
  python tools/detect_id_store.py export --out path.json
  python tools/detect_id_store.py clear [--force]

The script reads the descriptor vault under data/detect_id/; it is safe to run
while the realtime server is offline. For active servers, run `export` and a
manual merge to avoid interfering with ongoing writes.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict


DEFAULT_ROOT = Path(os.environ.get('DETECT_ID_ROOT', 'data/detect_id'))
INDEX_NAME = 'instances.json'


def _load_index(root: Path) -> Dict[str, Any]:
    index_path = root / INDEX_NAME
    if not index_path.exists():
        return {'instances': []}
    try:
        with index_path.open('r', encoding='utf-8') as fh:
            return json.load(fh)
    except Exception as e:
        print(f"[detect_id_store] Failed to read {index_path}: {e}", file=sys.stderr)
        return {'instances': []}


def _resolve_root(user_root: str | None) -> Path:
    root = Path(user_root) if user_root else DEFAULT_ROOT
    root.mkdir(parents=True, exist_ok=True)
    return root


def cmd_list(args: argparse.Namespace) -> int:
    root = _resolve_root(args.root)
    index = _load_index(root)
    instances = index.get('instances') or []
    if not instances:
        print('[detect_id_store] No instances found.')
        return 0
    instances = sorted(instances, key=lambda item: float(item.get('last_seen', 0.0)), reverse=True)
    limit = args.limit if args.limit is not None else 20
    print(f"[detect_id_store] Listing up to {limit} instances (total {len(instances)}):")
    for item in instances[:limit]:
        iid = item.get('id')
        last_seen = float(item.get('last_seen', 0.0))
        count = int(item.get('count', 0))
        meta = item.get('metadata') or {}
        label = meta.get('label') if isinstance(meta, dict) else None
        print(f"  - id={iid} count={count} last_seen={last_seen:.0f} label={label}")
    return 0


def cmd_show(args: argparse.Namespace) -> int:
    root = _resolve_root(args.root)
    index = _load_index(root)
    iid = args.instance_id
    for item in index.get('instances') or []:
        if str(item.get('id')) == iid:
            print(json.dumps(item, indent=2))
            vec_path = root / 'vectors' / f"{iid}.npy"
            thumb_path = root / 'thumbs' / f"{iid}.jpg"
            print(f"vector_file: {vec_path if vec_path.exists() else 'missing'}")
            print(f"thumbnail: {thumb_path if thumb_path.exists() else 'missing'}")
            return 0
    print(f"[detect_id_store] Instance '{iid}' not found.")
    return 1


def cmd_export(args: argparse.Namespace) -> int:
    root = _resolve_root(args.root)
    index = _load_index(root)
    out_path = Path(args.out)
    out_path.write_text(json.dumps(index, indent=2))
    print(f"[detect_id_store] Exported {len(index.get('instances') or [])} instances to {out_path}")
    return 0


def cmd_clear(args: argparse.Namespace) -> int:
    root = _resolve_root(args.root)
    if not args.force:
        resp = input(f"[detect_id_store] Delete all data under {root}? (y/N): ").strip().lower()
        if resp not in ('y', 'yes'):
            print('[detect_id_store] Aborted.')
            return 1
    removed = 0
    for sub in ('vectors', 'thumbs'):
        sub_dir = root / sub
        if sub_dir.exists():
            for path in sub_dir.glob('*'):
                try:
                    path.unlink()
                    removed += 1
                except Exception as e:
                    print(f"  ! Failed to remove {path}: {e}", file=sys.stderr)
    index_path = root / INDEX_NAME
    if index_path.exists():
        try:
            index_path.unlink()
        except Exception as e:
            print(f"  ! Failed to remove {index_path}: {e}", file=sys.stderr)
    print(f"[detect_id_store] Cleared store (removed {removed} artifacts).")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Inspect / manage descriptor store for detect_id endpoints')
    parser.add_argument('--root', type=str, default=None, help='Store root directory (default: data/detect_id or DETECT_ID_ROOT env)')

    sub = parser.add_subparsers(dest='cmd', required=True)
    p_list = sub.add_parser('list', help='List known instances ordered by last_seen timestamp')
    p_list.add_argument('--limit', type=int, default=20, help='Maximum number of instances to display (default: 20)')
    p_list.set_defaults(func=cmd_list)

    p_show = sub.add_parser('show', help='Show metadata for a specific instance')
    p_show.add_argument('instance_id', type=str, help='Instance identifier to inspect')
    p_show.set_defaults(func=cmd_show)

    p_export = sub.add_parser('export', help='Export the entire store metadata to a JSON file')
    p_export.add_argument('--out', type=str, required=True, help='Output file path')
    p_export.set_defaults(func=cmd_export)

    p_clear = sub.add_parser('clear', help='Remove all descriptors and thumbnails from the store')
    p_clear.add_argument('--force', action='store_true', help='Skip confirmation prompt')
    p_clear.set_defaults(func=cmd_clear)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == '__main__':
    raise SystemExit(main())
