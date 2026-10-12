import sys

from .cli import main


def _run():
    if len(sys.argv) <= 1:
        # no command given: open the friendly guided menu
        from .menu import run_menu
        run_menu()
    else:
        main()


if __name__ == "__main__":
    _run()
