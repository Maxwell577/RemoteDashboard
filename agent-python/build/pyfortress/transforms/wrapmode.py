"""Wrap mode (pure Python).

Each eligible module-level function's code object is extracted from the
compiled module, encrypted separately and replaced by a stub. A generated
wrapper decrypts it on entry (__fortress_unwrap__) and re-encrypts... i.e.
restores the stub on exit (__fortress_rewrap__), so the real bytecode only
exists in memory while the function actually runs. Re-entrant calls are
reference-counted by the runtime.
"""
import ast
import base64
import inspect
import marshal
import types

from .. import container as _c

_WRAPPER_SRC = (
    "def {name}(*__pf_a, **__pf_kw):\n"
    "    __pf_f = __fortress_unwrap__({real})\n"
    "    try:\n"
    "        return __pf_f(*__pf_a, **__pf_kw)\n"
    "    finally:\n"
    "        __fortress_rewrap__({real})\n"
)


def _top_level_functions(tree):
    out = []
    for st in tree.body:
        if isinstance(st, ast.FunctionDef) and not st.decorator_list:
            name = st.name
            if not (name.startswith("__") and name.endswith("__")):
                out.append(st)
    return out


def eligible(tree, excludes=()):
    """Pre-check which top-level functions can be wrapped (needs a compile)."""
    stub = compile(ast.parse(ast.unparse(tree)), "<w>", "exec")
    names = {st.name for st in _top_level_functions(tree) if st.name not in excludes}
    ok = set()
    for c in stub.co_consts:
        if isinstance(c, types.CodeType) and c.co_name in names:
            gen = c.co_flags & (inspect.CO_GENERATOR | inspect.CO_COROUTINE
                                | inspect.CO_ASYNC_GENERATOR | inspect.CO_ITERABLE_COROUTINE)
            if not gen and not c.co_freevars:
                ok.add(c.co_name)
    return ok


def apply(tree, excludes=()):
    """Rename eligible top-level functions, add wrappers; return (tree, wrap_pairs).

    The real code objects are extracted and encrypted by the pipeline after
    the final compile (they must come from the fully transformed module).
    """
    ok = eligible(tree, excludes)
    pairs = []
    body = list(tree.body)
    new_body = []
    counter = 0
    for st in body:
        if isinstance(st, ast.FunctionDef) and st.name in ok:
            orig = st.name
            real = "__pfw%d_%s" % (counter, orig)
            counter += 1
            st.name = real
            wrapper = ast.parse(_WRAPPER_SRC.format(name=orig, real=real)).body[0]
            new_body.append(st)
            new_body.append(wrapper)
            pairs.append((real, orig))
        else:
            new_body.append(st)
    tree.body = new_body
    ast.fix_missing_locations(tree)
    return tree, pairs
