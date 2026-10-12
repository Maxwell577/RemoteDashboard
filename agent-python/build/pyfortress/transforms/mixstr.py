"""mix-str mode: encrypt string/bytes constants.

Docstrings, __all__ elements and annotation-position strings are preserved.
Replaced constants become calls to the runtime-injected __ffs__ helper.
"""
import ast

from .. import container as _c

HELPER = "__ffs__"


def _collect_skips(tree):
    skips = set()

    def mark_all(node):
        for c in ast.walk(node):
            if isinstance(c, ast.Constant):
                skips.add(id(c))

    for n in ast.walk(tree):
        if isinstance(n, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            if n.body and isinstance(n.body[0], ast.Expr) and isinstance(n.body[0].value, ast.Constant):
                skips.add(id(n.body[0].value))
        if isinstance(n, ast.Assign):
            if any(isinstance(t, ast.Name) and t.id == "__all__" for t in n.targets):
                mark_all(n.value)
        if isinstance(n, ast.AnnAssign) and n.annotation is not None:
            mark_all(n.annotation)
        if isinstance(n, ast.arg) and n.annotation is not None:
            mark_all(n.annotation)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.returns is not None:
            mark_all(n.returns)
    return skips


class _Encryptor(ast.NodeTransformer):
    def __init__(self, str_key, skips):
        self.key = str_key
        self.skips = skips
        self.count = 0

    def visit_Constant(self, node):
        if id(node) in self.skips:
            return node
        v = node.value
        if not isinstance(v, (str, bytes)) or not v:
            return node
        blob = _c.enc_str(self.key, v)
        self.count += 1
        call = ast.Call(
            func=ast.Name(id=HELPER, ctx=ast.Load()),
            args=[ast.Constant(value=blob)],
            keywords=[],
        )
        return ast.copy_location(call, node)


def apply(tree, str_key):
    skips = _collect_skips(tree)
    enc = _Encryptor(str_key, skips)
    tree = enc.visit(tree)
    ast.fix_missing_locations(tree)
    return tree, enc.count
