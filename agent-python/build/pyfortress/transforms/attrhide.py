"""obf-code 2: hide attribute names via getattr/setattr/delattr with
encrypted attribute strings."""

import ast

from .. import container as _c

FFS = "__ffs__"


def _skip(node):
    a = node.attr
    if a.startswith("__") and a.endswith("__"):
        return True
    v = node.value
    if isinstance(v, ast.Call) and isinstance(v.func, ast.Name) and v.func.id == "super":
        return True
    return False


def _encname(key, attr, node):
    blob = _c.enc_str(key, attr)
    return ast.copy_location(
        ast.Call(func=ast.Name(id=FFS, ctx=ast.Load()),
                 args=[ast.Constant(value=blob)], keywords=[]),
        node,
    )


class _Hide(ast.NodeTransformer):
    def __init__(self, str_key):
        self.key = str_key

    def visit_Attribute(self, node):
        node.value = self.visit(node.value)
        if not isinstance(node.ctx, ast.Load) or _skip(node):
            return node
        call = ast.Call(
            func=ast.Name(id="getattr", ctx=ast.Load()),
            args=[node.value, _encname(self.key, node.attr, node)],
            keywords=[],
        )
        return ast.copy_location(call, node)

    def visit_Assign(self, node):
        self.generic_visit(node)
        if len(node.targets) == 1 and isinstance(node.targets[0], ast.Attribute):
            t = node.targets[0]
            if not _skip(t):
                call = ast.Call(
                    func=ast.Name(id="setattr", ctx=ast.Load()),
                    args=[t.value, _encname(self.key, t.attr, t), node.value],
                    keywords=[],
                )
                return ast.copy_location(ast.Expr(value=call), node)
        return node

    def visit_Delete(self, node):
        self.generic_visit(node)
        out = []
        for t in node.targets:
            if isinstance(t, ast.Attribute) and not _skip(t):
                call = ast.Call(
                    func=ast.Name(id="delattr", ctx=ast.Load()),
                    args=[t.value, _encname(self.key, t.attr, t)],
                    keywords=[],
                )
                out.append(ast.copy_location(ast.Expr(value=call), node))
            else:
                out.append(ast.copy_location(ast.Delete(targets=[t]), node))
        return out


def apply(tree, str_key):
    tree = _Hide(str_key).visit(tree)
    ast.fix_missing_locations(tree)
    return tree
