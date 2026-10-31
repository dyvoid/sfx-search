import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { FolderEntry } from "../types";

interface FolderNode {
  path: string;
  name: string;
  count: number;
  total: number;
  children: FolderNode[];
}

interface FolderTreeProps {
  folders: FolderEntry[];
  roots: string[];
  selected: string[];
  filterText: string;
  onToggle: (path: string) => void;
  /** "filter": select folders (and their subfolders) to search. "pick": choose one folder. */
  mode?: "filter" | "pick";
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
const normKey = (p: string) => norm(p).toLowerCase();

function ensureNode(
  byPath: Map<string, FolderNode>,
  path: string
): FolderNode {
  const key = normKey(path);
  let node = byPath.get(key);
  if (!node) {
    const clean = norm(path);
    node = {
      path: clean,
      name: clean.split("/").pop() || clean,
      count: 0,
      total: 0,
      children: [],
    };
    byPath.set(key, node);
  }
  return node;
}

function buildTree(folders: FolderEntry[], roots: string[]): FolderNode[] {
  const byPath = new Map<string, FolderNode>();
  const childOf = new Map<string, string>(); // child key -> parent key
  const topKeys = new Set<string>();

  const sortedRoots = roots
    .map(norm)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const rootFor = (path: string): string | null => {
    const lp = normKey(path);
    for (const r of sortedRoots) {
      const lr = r.toLowerCase();
      if (lp === lr || lp.startsWith(lr + "/")) {
        return r;
      }
    }
    return null;
  };

  const link = (childPath: string, parentPath: string) => {
    const ck = normKey(childPath);
    const pk = normKey(parentPath);
    if (ck !== pk) {
      childOf.set(ck, pk);
    }
  };

  for (const entry of folders) {
    const clean = norm(entry.path);
    if (!clean) {
      continue;
    }
    const leaf = ensureNode(byPath, clean);
    leaf.count += entry.count;

    const root = rootFor(clean);
    const parts = clean.split("/");
    // Walk ancestors from the leaf up to its root (or drive prefix when the
    // folder sits outside every configured root).
    const stopAt = root ? normKey(root) : normKey(parts[0]);
    let cur = clean;
    while (normKey(cur) !== stopAt) {
      const sep = cur.lastIndexOf("/");
      if (sep <= 0) {
        break;
      }
      const parent = cur.slice(0, sep);
      ensureNode(byPath, parent);
      link(cur, parent);
      cur = parent;
    }
    if (root) {
      const rootNode = ensureNode(byPath, root);
      if (normKey(clean) === normKey(root)) {
        rootNode.count += entry.count;
      }
      topKeys.add(normKey(root));
    } else {
      // Anchor to the drive/share prefix so loose folders still surface.
      const anchor = parts[0];
      ensureNode(byPath, anchor);
      if (normKey(clean) !== normKey(anchor)) {
        link(cur === clean ? clean : cur, anchor);
      }
      topKeys.add(normKey(anchor));
    }
  }

  const resolveTop = (key: string): string => {
    // climb to the highest ancestor key
    let k = key;
    while (childOf.has(k)) {
      k = childOf.get(k)!;
    }
    return k;
  };

  const tops = new Map<string, FolderNode>();
  for (const key of topKeys) {
    const topKey = resolveTop(key);
    tops.set(topKey, byPath.get(topKey)!);
  }
  for (const node of byPath.values()) {
    const parentKey = childOf.get(normKey(node.path));
    if (parentKey) {
      byPath.get(parentKey)!.children.push(node);
    }
  }
  const finalize = (n: FolderNode): number => {
    n.total = n.count;
    for (const c of n.children) {
      n.total += finalize(c);
    }
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    return n.total;
  };
  const result = [...tops.values()];
  result.forEach(finalize);
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

interface NodeRowProps {
  node: FolderNode;
  depth: number;
  expanded: Set<string>;
  onExpand: (path: string) => void;
  isIncluded: (path: string) => boolean;
  isViaAncestor: (path: string) => boolean;
  onToggle: (path: string) => void;
  mode: "filter" | "pick";
}

const NodeRow: React.FC<NodeRowProps> = ({
  node,
  depth,
  expanded,
  onExpand,
  isIncluded,
  isViaAncestor,
  onToggle,
  mode,
}) => {
  const key = normKey(node.path);
  const hasChildren = node.children.length > 0;
  const open = expanded.has(key);
  const checked = isIncluded(node.path);
  const viaAncestor = isViaAncestor(node.path);

  return (
    <>
      <div
        className={`sfx-ft-node ${checked ? "selected" : ""}`}
        style={{ paddingLeft: `calc(var(--space-3) + ${depth * 15}px)` }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="sfx-ft-chevron"
            onClick={() => onExpand(node.path)}
            aria-label={open ? "Collapse folder" : "Expand folder"}
          >
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        ) : (
          <span className="sfx-ft-chevron-spacer" />
        )}
        <button
          type="button"
          className="sfx-ft-check"
          onClick={() => onToggle(node.path)}
          disabled={viaAncestor}
          title={
            mode === "pick"
              ? "Save into this folder"
              : viaAncestor
              ? "Included via a selected parent folder"
              : checked
              ? "Stop filtering to this folder"
              : "Show only files in this folder (and subfolders)"
          }
          aria-label={mode === "pick" ? `Save into ${node.path}` : `Filter to ${node.path}`}
          aria-pressed={checked}
        >
          <span className={`ds-checkbox ${checked ? "on" : ""}`}>
            {checked && <span className="ds-checkbox-inner" />}
          </span>
        </button>
        <span
          className="sfx-ft-label"
          title={node.path}
          onClick={() => !viaAncestor && onToggle(node.path)}
        >
          {node.name}
        </span>
        <span className="sfx-ft-count ds-tnum">{node.total}</span>
      </div>
      {open &&
        node.children.map((c) => (
          <NodeRow
            key={normKey(c.path)}
            node={c}
            depth={depth + 1}
            expanded={expanded}
            onExpand={onExpand}
            isIncluded={isIncluded}
            isViaAncestor={isViaAncestor}
            onToggle={onToggle}
            mode={mode}
          />
        ))}
    </>
  );
};

export const FolderTree: React.FC<FolderTreeProps> = ({
  folders,
  roots,
  selected,
  filterText,
  onToggle,
  mode = "filter",
}) => {
  const tree = useMemo(() => buildTree(folders, roots), [folders, roots]);
  const [openSet, setOpenSet] = useState<Set<string>>(() => new Set());
  const [closedSet, setClosedSet] = useState<Set<string>>(() => new Set());

  // While a filter term is active, keep only matching nodes and their
  // ancestors so the match path stays visible.
  const filtered = useMemo(() => {
    const t = filterText.trim().toLowerCase();
    if (!t) {
      return null;
    }
    const keep = (n: FolderNode): FolderNode | null => {
      const kids = n.children
        .map(keep)
        .filter((k): k is FolderNode => k !== null);
      if (n.name.toLowerCase().includes(t) || kids.length > 0) {
        return { ...n, children: kids };
      }
      return null;
    };
    return tree.map(keep).filter((k): k is FolderNode => k !== null);
  }, [tree, filterText]);

  // Nodes are collapsed by default except top-level roots (one level open,
  // like a file explorer). The user opens/closes deeper nodes freely.
  const expanded = useMemo(() => {
    const set = new Set<string>();
    const collect = (nodes: FolderNode[], depth: number) => {
      for (const n of nodes) {
        const k = normKey(n.path);
        const open =
          filtered !== null ||
          openSet.has(k) ||
          (depth === 0 && !closedSet.has(k));
        if (open) {
          set.add(k);
          collect(n.children, depth + 1);
        }
      }
    };
    collect(filtered ?? tree, 0);
    return set;
  }, [tree, filtered, openSet, closedSet]);

  // Selecting a folder expands its ancestors once so the selection becomes
  // visible, but nothing is pinned open -- the user can collapse anything.
  const lastSelectedRef = useRef<string[]>([]);
  useEffect(() => {
    const added = selected.filter((s) => !lastSelectedRef.current.includes(s));
    lastSelectedRef.current = selected;
    if (added.length === 0) {
      return;
    }
    const addedKeys = new Set(added.map(normKey));
    const ancestors = new Set<string>();
    const walk = (nodes: FolderNode[], trail: string[]) => {
      for (const n of nodes) {
        const k = normKey(n.path);
        if (addedKeys.has(k)) {
          trail.forEach((t) => ancestors.add(t));
          ancestors.add(k);
        }
        walk(n.children, [...trail, k]);
      }
    };
    walk(tree, []);
    if (ancestors.size === 0) {
      return;
    }
    setOpenSet((prev) => new Set([...prev, ...ancestors]));
    setClosedSet((prev) => {
      const next = new Set(prev);
      ancestors.forEach((a) => next.delete(a));
      return next;
    });
  }, [selected, tree]);

  const toggleExpand = (path: string) => {
    const key = normKey(path);
    const isOpen = expanded.has(key);
    setOpenSet((prev) => {
      const next = new Set(prev);
      if (isOpen) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
    setClosedSet((prev) => {
      const next = new Set(prev);
      if (isOpen) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  };

  // A filter includes subfolders; a pick is exactly one folder.
  const isIncluded = (path: string) => {
    const lp = normKey(path);
    return selected.some(
      (s) =>
        lp === normKey(s) || (mode === "filter" && lp.startsWith(normKey(s) + "/"))
    );
  };
  const isViaAncestor = (path: string) => {
    const lp = normKey(path);
    return mode === "filter" && selected.some((s) => lp.startsWith(normKey(s) + "/"));
  };

  const visible = filtered ?? tree;
  return (
    <div className="sfx-ft-tree">
      {filtered !== null && filtered.length === 0 && (
        <div className="sfx-ft-empty">No folders match</div>
      )}
      {visible.map((n) => (
        <NodeRow
          key={normKey(n.path)}
          node={n}
          depth={0}
          expanded={expanded}
          onExpand={toggleExpand}
          isIncluded={isIncluded}
          isViaAncestor={isViaAncestor}
          onToggle={onToggle}
          mode={mode}
        />
      ))}
    </div>
  );
};
