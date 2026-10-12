"""assert-import / assert-call modes.

Injects __assert_armored__(obj) checks so obfuscated code refuses to run
if its imports/functions come from a non-obfuscated replacement module.
"""
import ast


def inject_import(tree, protected, resolve_from=None):
    """Append __assert_armored__(alias) after imports of protected modules.

    resolve_from: optional callable(node) -> module qualname for relative imports.
    """
    out = []
    for st in tree.body:
        out.append(st)
        if isinstance(st, ast.Import):
            for a in st.names:
                root = a.name.split(".")[0]
                bound = a.asname or root
                if a.name in protected or root in protected:
                    out.append(_assert_expr(bound, st))
        elif isinstance(st, ast.ImportFrom):
            mod = resolve_from(st) if (resolve_from and st.level) else st.module
            if mod is None:
                continue
            for a in st.names:
                if a.name == "*":
                    continue
                bound = a.asname or a.name
                if (mod + "." + a.name) in protected or (mod in protected and a.name != "*"):
                    out.append(_assert_expr(bound, st))
    tree.body = out
    ast.fix_missing_locations(tree)
    return tree


def _assert_expr(name, node):
    call = ast.Expr(value=ast.Call(
        func=ast.Name(id="__assert_armored__", ctx=ast.Load()),
        args=[ast.Name(id=name, ctx=ast.Load())],
        keywords=[],
    ))
    return ast.copy_location(call, node)


def inject_call(tree, protected_funcs):
    """Wrap calls to this module's protected functions: f(x) -> __assert_armored__(f)(x)."""
    if not protected_funcs:
        return tree

    class _T(ast.NodeTransformer):
        def visit_Call(self, node):
            node = self.generic_visit(node)
            if isinstance(node.func, ast.Name) and node.func.id in protected_funcs:
                guard = ast.Call(
                    func=ast.Name(id="__assert_armored__", ctx=ast.Load()),
                    args=[ast.Name(id=node.func.id, ctx=ast.Load())],
                    keywords=[],
                )
                node.func = ast.copy_location(guard, node)
            return node

    tree = _T().visit(tree)
    ast.fix_missing_locations(tree)
    return tree
