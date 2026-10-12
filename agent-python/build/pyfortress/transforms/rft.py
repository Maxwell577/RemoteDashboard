"""RFT mode: scope-aware identifier renaming.

Renames function-local names, module-level private names, comprehension
targets and lambda args with collision-free generated names. Class-scope
names, import aliases, dunders, __all__ entries and any name that also
appears as a string constant are left untouched (safety net).
"""
import ast
import builtins
import random
import re
import string

BUILTIN_NAMES = set(dir(builtins))
RESERVED = {"__all__", "__file__", "__name__", "__doc__", "__package__", "__spec__"}
DYNAMIC = {"globals", "locals", "vars", "dir", "eval", "exec", "__import__", "breakpoint", "pdb"}
_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

FUNCTION_KINDS = ("function", "lambda", "comprehension")


def _dunder(name):
    return name.startswith("__") and name.endswith("__")


class Scope:
    __slots__ = ("kind", "node", "parent", "binds", "imports", "gdecl", "nldecl",
                 "renames", "risky", "func_name", "argmap", "kids", "funcdefs",
                 "classdefs")

    def __init__(self, kind, node, parent):
        self.kind = kind
        self.node = node
        self.parent = parent
        self.binds = set()
        self.imports = set()
        self.gdecl = set()
        self.nldecl = set()
        self.renames = {}
        self.risky = False
        self.func_name = None
        self.argmap = None
        self.kids = []
        self.funcdefs = {}
        self.classdefs = {}


class Analyzer(ast.NodeVisitor):
    """Pass 1: build the scope tree, collect bindings/strings/risk."""

    def __init__(self):
        self.stack = []
        self.module_scope = None
        self.all_strings = set()
        self.dunder_all = set()
        self.used_ids = set()
        self.import_aliases = {}      # binding -> ('abs', qualname) | ('rel', level, module, attr)
        self.rel_imports = []         # raw ImportFrom nodes with level>0
        self.import_bindings = set()

    @property
    def cur(self):
        return self.stack[-1]

    def _new_scope(self, kind, node, parent):
        s = Scope(kind, node, parent)
        if parent is not None:
            parent.kids.append(s)
        return s

    def visit_Module(self, node):
        s = self._new_scope("module", node, None)
        self.module_scope = s
        self.stack.append(s)
        self.generic_visit(node)
        self.stack.pop()

    # -- helpers -------------------------------------------------------
    def _bind(self, name, scope=None):
        s = scope or self.cur
        if name in s.gdecl:
            self.module_scope.binds.add(name)
        elif name in s.nldecl:
            tgt = self._nonlocal_target(name, s)
            if tgt:
                tgt.binds.add(name)
        else:
            s.binds.add(name)

    def _nonlocal_target(self, name, start):
        s = start.parent
        while s is not None:
            if s.kind != "module" and name in s.binds:
                return s
            if s.kind == "module":
                return None
            s = s.parent
        return None

    def _mark_risky(self, name):
        if name in DYNAMIC:
            self.cur.risky = True
            self.module_scope.risky = True

    def _track_id(self, name):
        if name and _IDENT_RE.match(name):
            self.used_ids.add(name)

    # -- visitors ------------------------------------------------------
    def visit_Name(self, node):
        self._track_id(node.id)
        self._mark_risky(node.id)
        if isinstance(node.ctx, ast.Store):
            self._bind(node.id)

    def visit_Constant(self, node):
        if isinstance(node.value, str):
            self.all_strings.add(node.value)

    def visit_Call(self, node):
        if isinstance(node.func, ast.Name):
            self._mark_risky(node.func.id)
        self.generic_visit(node)

    def visit_Global(self, node):
        self.cur.gdecl.update(node.names)
        for n in node.names:
            self.module_scope.binds.add(n)

    def visit_Nonlocal(self, node):
        self.cur.nldecl.update(node.names)

    def visit_Import(self, node):
        for a in node.names:
            b = a.asname or a.name.split(".")[0]
            self.cur.imports.add(b)
            self.import_bindings.add(b)
            self.import_aliases[b] = ("abs", a.name if a.asname else a.name.split(".")[0])
            self._track_id(b)

    def visit_ImportFrom(self, node):
        if node.level:
            self.rel_imports.append(node)
        for a in node.names:
            if a.name == "*":
                self.module_scope.risky = True
                self.cur.risky = True
                continue
            b = a.asname or a.name
            self.cur.imports.add(b)
            self.import_bindings.add(b)
            if node.level:
                self.import_aliases[b] = ("rel", node.level, node.module or "", a.name)
            else:
                self.import_aliases[b] = ("abs", (node.module or "") + "." + a.name)
            self._track_id(b)
        self.generic_visit(node)

    def _visit_func_common(self, node, kind):
        cur = self.cur
        cur.binds.add(node.name)
        self._track_id(node.name)
        s = self._new_scope(kind, node, cur)
        s.func_name = node.name
        s.argmap = {}
        for a in node.args.posonlyargs + node.args.args + node.args.kwonlyargs:
            s.binds.add(a.arg)
            self._track_id(a.arg)
        if node.args.vararg:
            s.binds.add(node.args.vararg.arg)
        if node.args.kwarg:
            s.binds.add(node.args.kwarg.arg)
        # decorators / defaults / annotations evaluate in the OUTER scope
        for d in node.decorator_list:
            self.visit(d)
        for d in node.args.defaults:
            self.visit(d)
        for d in node.args.kw_defaults:
            if d is not None:
                self.visit(d)
        for a in node.args.posonlyargs + node.args.args + node.args.kwonlyargs:
            if a.annotation:
                self.visit(a.annotation)
        if node.returns:
            self.visit(node.returns)
        self.stack.append(s)
        for st in node.body:
            self.visit(st)
        self.stack.pop()

    def visit_FunctionDef(self, node):
        self._visit_func_common(node, "function")

    def visit_AsyncFunctionDef(self, node):
        self._visit_func_common(node, "function")

    def visit_Lambda(self, node):
        s = self._new_scope("lambda", node, self.cur)
        for a in node.args.posonlyargs + node.args.args + node.args.kwonlyargs:
            s.binds.add(a.arg)
            self._track_id(a.arg)
        if node.args.vararg:
            s.binds.add(node.args.vararg.arg)
        if node.args.kwarg:
            s.binds.add(node.args.kwarg.arg)
        for d in node.args.defaults:
            self.visit(d)
        for d in node.args.kw_defaults:
            if d is not None:
                self.visit(d)
        self.stack.append(s)
        self.visit(node.body)
        self.stack.pop()

    def visit_ClassDef(self, node):
        self.cur.binds.add(node.name)
        self._track_id(node.name)
        for d in node.decorator_list:
            self.visit(d)
        for b in node.bases:
            self.visit(b)
        for k in node.keywords:
            self.visit(k.value)
        s = self._new_scope("class", node, self.cur)
        self.stack.append(s)
        for st in node.body:
            self.visit(st)
        self.stack.pop()

    def _visit_comp(self, node):
        s = self._new_scope("comprehension", node, self.cur)
        gens = node.generators
        self.visit(gens[0].iter)  # first iterable in the enclosing scope
        self.stack.append(s)
        for i, g in enumerate(gens):
            for t in ast.walk(g.target):
                if isinstance(t, ast.Name):
                    s.binds.add(t.id)
                    self._track_id(t.id)
            if i:
                self.visit(g.iter)  # 2nd+ iterables evaluate in comp scope
            for cond in g.ifs:
                self.visit(cond)
        if isinstance(node, ast.DictComp):
            self.visit(node.key)
            self.visit(node.value)
        else:
            self.visit(node.elt)
        self.stack.pop()

    def visit_ListComp(self, node):
        self._visit_comp(node)

    def visit_SetComp(self, node):
        self._visit_comp(node)

    def visit_GeneratorExp(self, node):
        self._visit_comp(node)

    def visit_DictComp(self, node):
        self._visit_comp(node)

    def visit_NamedExpr(self, node):
        # PEP 572: walrus target binds in nearest enclosing function/module scope
        self.visit(node.value)
        if isinstance(node.target, ast.Name):
            s = self.cur
            while s is not None and s.kind == "comprehension":
                s = s.parent
            self._bind(node.target.id, s or self.module_scope)
            self._track_id(node.target.id)

    def visit_Assign(self, node):
        for t in node.targets:
            if isinstance(t, ast.Name) and t.id == "__all__" and self.cur.kind == "module":
                for n in ast.walk(node.value):
                    if isinstance(n, ast.Constant) and isinstance(n.value, str):
                        self.dunder_all.add(n.value)
        self.generic_visit(node)

    def visit_ExceptHandler(self, node):
        if node.name:
            self._bind(node.name)
            self._track_id(node.name)
        self.generic_visit(node)

    def visit_MatchAs(self, node):
        if node.name:
            self._bind(node.name)
            self._track_id(node.name)
        if node.pattern:
            self.visit(node.pattern)

    def visit_MatchStar(self, node):
        if node.name:
            self._bind(node.name)

    def visit_MatchMapping(self, node):
        if node.rest:
            self._bind(node.rest)
        self.generic_visit(node)




# ---------------------------------------------------------------- pass 2: decide

class ModuleInfo:
    def __init__(self, analyzer, module_name):
        self.a = analyzer
        self.module_name = module_name
        self.module_renames = {}     # old -> new for module-level private names
        self.funcargmaps = {}        # module func old-name -> {arg_old: arg_new}
        self.scope_by_node = {}
        self.exports = set()         # cross-module names other modules import
        ms = analyzer.module_scope
        stack = [ms]
        while stack:
            s = stack.pop()
            self.scope_by_node[id(s.node)] = s
            stack.extend(s.kids)

    @property
    def import_aliases(self):
        return self.a.import_aliases


def analyze(tree):
    a = Analyzer()
    a.visit(tree)
    return a


def decide(a, module_name, excludes=(), rng=None):
    """Choose rename maps for every scope. Returns ModuleInfo."""
    rng = rng or random.Random()
    info = ModuleInfo(a, module_name)
    used = set(a.used_ids)

    def new_name():
        for _ in range(400):
            n = "_0x" + "".join(rng.choice("0123456789abcdef") for _ in range(4))
            if n not in used:
                used.add(n)
                return n
        raise RuntimeError("cannot generate unique rename target")

    ms = a.module_scope
    hits = set()
    for name in sorted(ms.binds):
        if (_dunder(name) or name in RESERVED or name in ms.imports
                or name in a.dunder_all or name in excludes or name in a.all_strings
                or name in BUILTIN_NAMES):
            continue
        hits.add(name)
    if ms.risky:
        hits = set()
    for name in sorted(hits):
        ms.renames[name] = new_name()
    info.module_renames = dict(ms.renames)

    def walk(s):
        if s.kind in FUNCTION_KINDS and not s.risky:
            for name in sorted(s.binds):
                if _dunder(name) or name in a.all_strings or name in s.imports:
                    continue
                if name in s.gdecl or name in s.nldecl:
                    continue
                if name in ms.renames and s.kind == "function" and name in s.gdecl:
                    continue
                s.renames[name] = new_name()
            if s.func_name and s.kind == "function" and s.node is not None:
                amap = {a_.arg: s.renames.get(a_.arg, a_.arg)
                        for a_ in (s.node.args.posonlyargs + s.node.args.args
                                   + s.node.args.kwonlyargs) if a_.arg in s.renames}
                if amap:
                    s.argmap = amap
                    info.funcargmaps[s.func_name] = amap
        for k in s.kids:
            walk(k)

    walk(ms)
    return info


# ---------------------------------------------------------------- pass 3: rewrite

class Rewriter(ast.NodeTransformer):
    def __init__(self, info):
        self.info = info
        self.a = info.a
        self.by_node = info.scope_by_node
        self.stack = []
        # pre-register function scopes so call-site keyword fixing works
        # even for calls that appear before the def in source order
        for s in info.scope_by_node.values():
            if s.kind == "function" and s.func_name and s.parent is not None:
                s.parent.funcdefs[s.func_name] = s
        # same for class scopes: `Game(...)` instantiation must consult
        # Game.__init__'s renamed params
        for s in info.scope_by_node.values():
            if s.kind == "class" and s.parent is not None and s.node is not None:
                s.parent.classdefs[s.node.name] = s

    def cur(self):
        return self.stack[-1]

    def _resolve(self, name, scope):
        came_from_func = scope.kind in FUNCTION_KINDS
        s = scope
        while s is not None:
            if s.kind == "class" and came_from_func:
                s = s.parent
                continue
            if name in s.gdecl:
                return self.a.module_scope
            if name in s.binds:
                return s
            if s.kind == "module":
                return None
            came_from_func = came_from_func or s.kind in FUNCTION_KINDS
            s = s.parent
        return None

    def _rename(self, name):
        s = self._resolve(name, self.cur())
        if s is not None:
            return s.renames.get(name, name)
        return name

    def visit_Name(self, node):
        new = self._rename(node.id)
        if new != node.id:
            return ast.copy_location(ast.Name(id=new, ctx=node.ctx), node)
        return node

    def visit_arg(self, node):
        new = self.cur().renames.get(node.arg, node.arg)
        if new != node.arg:
            return ast.copy_location(ast.arg(arg=new, annotation=node.annotation), node)
        return node

    def visit_Global(self, node):
        ms = self.a.module_scope
        node.names = [ms.renames.get(n, n) for n in node.names]
        return node

    def visit_Nonlocal(self, node):
        out = []
        for n in node.names:
            s = self.cur().parent
            tgt = None
            while s is not None:
                if s.kind != "module" and n in s.binds:
                    tgt = s
                    break
                if s.kind == "module":
                    break
                s = s.parent
            out.append(tgt.renames.get(n, n) if tgt else n)
        node.names = out
        return node

    def _visit_scope_node(self, node, kind, rename_name=True):
        cur = self.cur()
        if rename_name and node.name in cur.renames:
            node.name = cur.renames[node.name]
        s = self.by_node.get(id(node))
        # outer-scope expressions first (matches analyzer order)
        node.decorator_list = [self.visit(d) for d in (node.decorator_list or [])]
        args = getattr(node, "args", None)
        if args is not None:
            args.defaults = [self.visit(d) for d in args.defaults]
            args.kw_defaults = [self.visit(d) if d is not None else None
                                for d in args.kw_defaults]
            for a in args.posonlyargs + args.args + args.kwonlyargs:
                if a.annotation:
                    a.annotation = self.visit(a.annotation)
        if getattr(node, "returns", None):
            node.returns = self.visit(node.returns)
        if s is None:
            self.generic_visit(node)
            return node
        self.stack.append(s)
        if args is not None:
            args.posonlyargs = [self.visit(a) for a in args.posonlyargs]
            args.args = [self.visit(a) for a in args.args]
            args.kwonlyargs = [self.visit(a) for a in args.kwonlyargs]
            if args.vararg:
                args.vararg = self.visit(args.vararg)
            if args.kwarg:
                args.kwarg = self.visit(args.kwarg)
        if kind == "class":
            node.bases = [self.visit(b) for b in node.bases]
            for k in node.keywords:
                k.value = self.visit(k.value)
        node.body = [self.visit(st) for st in node.body]
        self.stack.pop()
        return node

    def visit_FunctionDef(self, node):
        return self._visit_scope_node(node, "function")

    def visit_AsyncFunctionDef(self, node):
        return self._visit_scope_node(node, "function")

    def visit_ClassDef(self, node):
        return self._visit_scope_node(node, "class")

    def visit_Lambda(self, node):
        s = self.by_node.get(id(node))
        if s is None:
            return self.generic_visit(node)
        node.args.defaults = [self.visit(d) for d in node.args.defaults]
        node.args.kw_defaults = [self.visit(d) if d is not None else None
                                 for d in node.args.kw_defaults]
        self.stack.append(s)
        node.args.posonlyargs = [self.visit(a) for a in node.args.posonlyargs]
        node.args.args = [self.visit(a) for a in node.args.args]
        node.args.kwonlyargs = [self.visit(a) for a in node.args.kwonlyargs]
        if node.args.vararg:
            node.args.vararg = self.visit(node.args.vararg)
        if node.args.kwarg:
            node.args.kwarg = self.visit(node.args.kwarg)
        node.body = self.visit(node.body)
        self.stack.pop()
        return node

    def _visit_comp(self, node):
        s = self.by_node.get(id(node))
        if s is None:
            return self.generic_visit(node)
        gens = node.generators
        gens[0].iter = self.visit(gens[0].iter)
        self.stack.append(s)
        for i, g in enumerate(gens):
            if i:
                g.iter = self.visit(g.iter)  # 2nd+ iterables eval in comp scope
            g.target = self.visit(g.target)
            g.ifs = [self.visit(c) for c in g.ifs]
        if isinstance(node, ast.DictComp):
            node.key = self.visit(node.key)
            node.value = self.visit(node.value)
        else:
            node.elt = self.visit(node.elt)
        self.stack.pop()
        return node

    def visit_ListComp(self, node):
        return self._visit_comp(node)

    def visit_SetComp(self, node):
        return self._visit_comp(node)

    def visit_GeneratorExp(self, node):
        return self._visit_comp(node)

    def visit_DictComp(self, node):
        return self._visit_comp(node)

    def visit_ExceptHandler(self, node):
        if node.name:
            new = self.cur().renames.get(node.name, node.name)
            node.name = new
        self.generic_visit(node)
        return node

    def visit_MatchAs(self, node):
        if node.pattern:
            self.visit(node.pattern)
        if node.name:
            node.name = self.cur().renames.get(node.name, node.name)
        return node

    def visit_MatchStar(self, node):
        if node.name:
            node.name = self.cur().renames.get(node.name, node.name)
        return node

    def visit_MatchMapping(self, node):
        self.generic_visit(node)
        if node.rest:
            node.rest = self.cur().renames.get(node.rest, node.rest)
        return node

    def visit_Call(self, node):
        # keyword-argument fixing for same-module callees whose params got renamed
        amap = None
        if isinstance(node.func, ast.Name):
            s = self._resolve(node.func.id, self.cur())
            if s is not None:
                fscope = s.funcdefs.get(node.func.id)
                if fscope is not None and fscope.argmap:
                    amap = fscope.argmap
                elif s.kind == "module" and node.func.id in self.info.funcargmaps:
                    amap = self.info.funcargmaps[node.func.id]
                else:
                    cscope = s.classdefs.get(node.func.id)
                    if cscope is not None:
                        iscope = cscope.funcdefs.get("__init__")
                        if iscope is not None and iscope.argmap:
                            amap = iscope.argmap
        self.generic_visit(node)
        if amap:
            for kw in node.keywords:
                if kw.arg is not None and kw.arg in amap:
                    kw.arg = amap[kw.arg]
        return node


def apply(tree, info):
    """Pass 3: rewrite identifiers using the decided maps."""
    r = Rewriter(info)
    r.stack = [info.a.module_scope]
    new = r.visit(tree)
    ast.fix_missing_locations(new)
    return new


# ------------------------------------------------- cross-module references

class CrossRewriter(ast.NodeTransformer):
    """Rewrites `mod.name` / `from mod import name` / keyword args that refer
    to OTHER protected modules whose module-level names were renamed."""

    def __init__(self, module_name, package, maps, funcargs, protected):
        self.module_name = module_name
        self.pkg = package or ""
        self.maps = maps
        self.funcargs = funcargs
        self.protected = protected
        self.import_targets = {}
        self.exports = {}

    def _resolve_rel(self, level, module):
        parts = self.pkg.split(".") if self.pkg else []
        if level - 1 > len(parts):
            return None
        base = parts[: len(parts) - (level - 1)]
        if module:
            base = base + module.split(".")
        return ".".join(base)

    def visit_Import(self, node):
        for a in node.names:
            b = a.asname or a.name.split(".")[0]
            self.import_targets[b] = ("module", a.name if a.asname else a.name.split(".")[0])
        return node

    def visit_ImportFrom(self, node):
        mod = node.module
        if node.level:
            mod = self._resolve_rel(node.level, node.module)
        if mod is None:
            return node
        for a in node.names:
            if a.name == "*":
                continue
            orig = a.name
            full = mod + "." + orig
            binding = a.asname or orig
            if full in self.protected:
                self.import_targets[binding] = ("module", full)
            elif mod in self.maps and orig in self.maps[mod]:
                new = self.maps[mod][orig]
                if a.asname is None:
                    a.asname = orig
                a.name = new
                self.exports.setdefault(mod, set()).add(new)
                self.import_targets[binding] = ("attr", mod, orig)
        return node

    def visit_Attribute(self, node):
        node.value = self.visit(node.value)
        chain = []
        root = node
        while isinstance(root, ast.Attribute):
            chain.append(root.attr)
            root = root.value
        if not isinstance(root, ast.Name):
            return node
        tgt = self.import_targets.get(root.id)
        if not tgt or tgt[0] != "module":
            return node
        qual = tgt[1]
        chain.reverse()
        new_attrs = []
        changed = False
        i = 0
        while i < len(chain):
            attr = chain[i]
            if qual and qual in self.maps and attr in self.maps[qual]:
                new = self.maps[qual][attr]
                new_attrs.append(new)
                self.exports.setdefault(qual, set()).add(new)
                changed = True
                i += 1
                break
            sub = (qual + "." + attr) if qual else attr
            if sub in self.protected:
                new_attrs.append(attr)
                qual = sub
                i += 1
                continue
            break
        new_attrs.extend(chain[i:])
        if not changed:
            return node
        result = root
        for attr in new_attrs:
            result = ast.Attribute(value=result, attr=attr, ctx=ast.Load())
        result = ast.copy_location(result, node)
        result.ctx = node.ctx
        return result

    def visit_Call(self, node):
        amap = None
        if isinstance(node.func, ast.Name):
            tgt = self.import_targets.get(node.func.id)
            if tgt and tgt[0] == "attr":
                _t, mod, orig = tgt
                amap = self.funcargs.get(mod, {}).get(orig)
        elif isinstance(node.func, ast.Attribute):
            chain, root = [], node.func
            while isinstance(root, ast.Attribute):
                chain.append(root.attr)
                root = root.value
            if isinstance(root, ast.Name):
                tgt = self.import_targets.get(root.id)
                if tgt and tgt[0] == "module":
                    qual = tgt[1]
                    chain.reverse()
                    ok = True
                    for attr in chain[:-1]:
                        sub = qual + "." + attr
                        if sub in self.protected:
                            qual = sub
                        else:
                            ok = False
                            break
                    if ok:
                        amap = self.funcargs.get(qual, {}).get(chain[-1])
        node = self.generic_visit(node)
        if amap:
            for kw in node.keywords:
                if kw.arg in amap:
                    kw.arg = amap[kw.arg]
        return node


def cross_rewrite(tree, module_name, package, infos, protected):
    maps = {m: i.module_renames for m, i in infos.items()}
    funcargs = {m: i.funcargmaps for m, i in infos.items()}
    cr = CrossRewriter(module_name, package, maps, funcargs, protected)
    tree = cr.visit(tree)
    ast.fix_missing_locations(tree)
    return tree, cr.exports
