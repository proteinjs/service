# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

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
