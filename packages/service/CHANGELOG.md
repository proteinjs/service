# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [1.9.0](https://github.com/proteinjs/service/compare/@proteinjs/service@1.8.0...@proteinjs/service@1.9.0) (2026-10-01)


### Bug Fixes

* **service:** count the keepalive budget before a request leaves; never re-send one ([4fe550b](https://github.com/proteinjs/service/commit/4fe550b7b9d897de9a3329316ec8f909f81f8f65))
* **service:** re-check the redelivery bound after the pause, not only before it ([de5aac2](https://github.com/proteinjs/service/commit/de5aac205d1e99ee9cd7dc5d8ca19685f3079bbb))
* **service:** refuse a retry declaration on a debounced method ([f569c94](https://github.com/proteinjs/service/commit/f569c9423fa94cb1e36b42a1adf72ff4867e70c9))
* **service:** the body bound applies to redeliverable deliveries only ([de19003](https://github.com/proteinjs/service/commit/de19003ddb06bc326fb9ddd610160e0564feac1d))


### Features

* **service:** a proxy's 502/503/504 is a transport failure for a redeliverable method ([71760d7](https://github.com/proteinjs/service/commit/71760d7a51816d06e77d7393aa3a41aeb6343983))
* **service:** bound the response body on the same abort signal; a lost answer is a transport error ([4889fa4](https://github.com/proteinjs/service/commit/4889fa419571c666725b457d00e3004a257ad131))
* **service:** no first-contact watchdog on a keyed write by default; a per-method opt-in ([db50402](https://github.com/proteinjs/service/commit/db50402ff52a258234edcd20cbe0493315a4cd37))
* **service:** refuse a keyed call on a multi-process server with no shared ledger ([c6d9257](https://github.com/proteinjs/service/commit/c6d9257c8fc78eb9809b6efc3edda402c9df5dde))





# [1.8.0](https://github.com/proteinjs/service/compare/@proteinjs/service@1.7.0...@proteinjs/service@1.8.0) (2026-10-01)


### Features

* the client's retry policy by class — reads under a jittered exponential series, idempotent writes under one key the server runs once ([3503f6a](https://github.com/proteinjs/service/commit/3503f6ac0204fc4b6d32c9199aaadb22211211f9))





# [1.7.0](https://github.com/proteinjs/service/compare/@proteinjs/service@1.6.0...@proteinjs/service@1.7.0) (2026-10-01)


### Features

* a first-contact watchdog and one redelivery for service methods declared reads ([a2dcb79](https://github.com/proteinjs/service/commit/a2dcb79452ff552abc47596288f59df2b0bc41ad))





# [1.6.0](https://github.com/proteinjs/service/compare/@proteinjs/service@1.5.6...@proteinjs/service@1.6.0) (2026-09-24)


### Bug Fixes

* a refusal settled on the fire-and-forget path logs the same one WARN entry — never an ERROR carrying its message ([015c43f](https://github.com/proteinjs/service/commit/015c43f9bcd296f7ff36c3a0d25287925fca21c1))


### Features

* ServiceRefusal — a refusal an operation throws on purpose answers with its own status and logs at WARN ([3d6ecf2](https://github.com/proteinjs/service/commit/3d6ecf22ef63499ac75ba8c68773b12a59bb894c))





## [1.5.6](https://github.com/proteinjs/service/compare/@proteinjs/service@1.5.5...@proteinjs/service@1.5.6) (2026-09-23)


### Bug Fixes

* ServiceClient carries per-request transport options from a one-slot provider — keepalive for a page that is hiding or unloading ([86f043c](https://github.com/proteinjs/service/commit/86f043cef3ca435a588e6855205c894721af01d1))
* the request-init provider's bodyBytes counts the body's UTF-8 bytes, not its code units ([ac0e563](https://github.com/proteinjs/service/commit/ac0e5633c11f03f0ed28027fc769dfecf6414baf))





## [1.5.5](https://github.com/proteinjs/service/compare/@proteinjs/service@1.5.4...@proteinjs/service@1.5.5) (2026-09-13)

**Note:** Version bump only for package @proteinjs/service





## [1.5.4](https://github.com/proteinjs/service/compare/@proteinjs/service@1.5.3...@proteinjs/service@1.5.4) (2026-08-27)


### Bug Fixes

* **service:** info-level service logs are summaries, full payloads move to debug — the log-shape fix ([d2b3e79](https://github.com/proteinjs/service/commit/d2b3e79ad731497109507c8f7c253633cfad6221))





## [1.5.3](https://github.com/proteinjs/service/compare/@proteinjs/service@1.5.2...@proteinjs/service@1.5.3) (2026-08-18)


### Bug Fixes

* prod service logs leaked user content — verbose args/return logging is now dev-only ([0fc5f16](https://github.com/proteinjs/service/commit/0fc5f16b0a147b7cc6718c6a0a20b04310076f60))





## [1.5.2](https://github.com/proteinjs/service/compare/@proteinjs/service@1.5.1...@proteinjs/service@1.5.2) (2026-08-13)

**Note:** Version bump only for package @proteinjs/service





# [1.4.0](https://github.com/proteinjs/service/compare/@proteinjs/service@1.3.2...@proteinjs/service@1.4.0) (2026-07-31)


### Features

* **service:** carry server error messages through the transport ([af6077a](https://github.com/proteinjs/service/commit/af6077a0e7118949a80411bbe653cd99be1482d4))





# [1.3.0](https://github.com/proteinjs/service/compare/@proteinjs/service@1.2.15...@proteinjs/service@1.3.0) (2026-07-10)


### Features

* export ServiceError ([0e03b92](https://github.com/proteinjs/service/commit/0e03b92baf9fa0e212c4aa53321d318a5fdc136c))





# [1.2.0](https://github.com/proteinjs/service/compare/@proteinjs/service@1.1.1...@proteinjs/service@1.2.0) (2025-02-06)


### Bug Fixes

* fix typing for the debounce config ([62bb2d6](https://github.com/proteinjs/service/commit/62bb2d646e2c71f2bf5300364cd92bbd95911f21))


### Features

* method specific debouncers. allows one service to use multiple debouncers for each method in the service. ([00fa7b2](https://github.com/proteinjs/service/commit/00fa7b23c4960ad9a006d4791e9f5a12f9ab6c89))





## [1.1.1](https://github.com/proteinjs/service/compare/@proteinjs/service@1.1.0...@proteinjs/service@1.1.1) (2024-09-10)


### Bug Fixes

* move retry logic into ServiceClient. send 400s in ServiceRouter if there is an error in the routing. ([742aa15](https://github.com/proteinjs/service/commit/742aa15ce505f115e94093fc96e6cac811aaf83e))





# [1.1.0](https://github.com/proteinjs/service/compare/@proteinjs/service@1.0.32...@proteinjs/service@1.1.0) (2024-09-09)


### Features

* Add retry functionality to serviceFactory with configurable retries per method. Implement RetryConfig type and logic to handle retries for specified service methods. ([cc9627f](https://github.com/proteinjs/service/commit/cc9627fe12aa40920764e0fa2debc1547881b887))





## [1.0.32](https://github.com/proteinjs/service/compare/@proteinjs/service@1.0.31...@proteinjs/service@1.0.32) (2024-08-30)


### Bug Fixes

* avoid logging twice for service errors ([5f5e593](https://github.com/proteinjs/service/commit/5f5e59377fbd81d90d4607bd6e56aa2865c7e38d))





## [1.0.28](https://github.com/proteinjs/service/compare/@proteinjs/service@1.0.27...@proteinjs/service@1.0.28) (2024-08-16)


### Bug Fixes

* refactored to implement new @proteinjs/logger/Logger api ([64960ad](https://github.com/proteinjs/service/commit/64960ade33b0f9f85891e9abaf0dbba35e695d0c))





## [1.0.23](https://github.com/proteinjs/service/compare/@proteinjs/service@1.0.22...@proteinjs/service@1.0.23) (2024-07-20)


### Bug Fixes

* updated service logging to log objects without serialization metadata ([8614452](https://github.com/proteinjs/service/commit/86144527b48c35ed95fe6e337f29b027195399ee))





## [1.0.17](https://github.com/proteinjs/service/compare/@proteinjs/service@1.0.16...@proteinjs/service@1.0.17) (2024-05-23)


### Bug Fixes

* logging of returned objects should be more clear when the service method is void ([cdfe631](https://github.com/proteinjs/service/commit/cdfe631a2859a1ccd2de210232a4b3b58c86e094))





## [1.0.14](https://github.com/proteinjs/service/compare/@proteinjs/service@1.0.13...@proteinjs/service@1.0.14) (2024-05-18)


### Bug Fixes

* `ServiceClient` now collapses request and response objects in logs, and adds a request number ([d070169](https://github.com/proteinjs/service/commit/d0701698683826bd01ba767dee9986be9fe53cc5))





## [1.0.11](https://github.com/proteinjs/service/compare/@proteinjs/service@1.0.10...@proteinjs/service@1.0.11) (2024-05-10)


### Bug Fixes

* add .md file type to lint ignore files ([c952d3b](https://github.com/proteinjs/service/commit/c952d3bb42a8ad5795d02ca92bc9b470a5f7bedd))





## [1.0.10](https://github.com/proteinjs/service/compare/@proteinjs/service@1.0.9...@proteinjs/service@1.0.10) (2024-05-10)


### Bug Fixes

* add linting and lint all files ([a5e5e07](https://github.com/proteinjs/service/commit/a5e5e07806eeb958fcbe65f1ae2f33be97aae792))





## [1.0.5](https://github.com/proteinjs/service/compare/@proteinjs/service@1.0.4...@proteinjs/service@1.0.5) (2024-04-24)

**Note:** Version bump only for package @proteinjs/service

## 1.0.1 (2024-04-19)

**Note:** Version bump only for package @proteinjs/service
