# Rive test files

Real `.riv` files used by `test/exact/rive.test.ts`, copied unchanged from Rive's own runtime test assets.

| File | Source | SHA-256 |
|---|---|---|
| `cubic_value_test.riv` | https://github.com/rive-app/rive-runtime/blob/9afebeb046659cc3ffed906825023012e4d3cd48/tests/unit_tests/assets/cubic_value_test.riv | `7e45ccafca023189ace6bb218669b1057d0944a58825041c41a11062577ad60c` |
| `light_switch.riv` | https://github.com/rive-app/rive-runtime/blob/9afebeb046659cc3ffed906825023012e4d3cd48/tests/unit_tests/assets/light_switch.riv | `d1e4227b1c9817d07466bf52255d4aec22cf73654d0d875e48a7e2a0826a62c2` |

Licence: MIT, Copyright (c) 2020 Rive. The full licence text, with its permission notice, is in `LICENSE` next to this file
(copied unchanged from https://github.com/rive-app/rive-runtime/blob/9afebeb046659cc3ffed906825023012e4d3cd48/LICENSE).

The values the tests check come from Rive's own runtime tests for the same files:
`tests/unit_tests/runtime/cubic_value_test.cpp` (grey_rectangle x is 290.71 at frame 15 and 363.01 at frame 11, three
cubic value interpolators) and `tests/unit_tests/runtime/state_machine_event_test.cpp` (one state machine with a boolean
input `On` that starts true).
