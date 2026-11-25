"""按职责拆分的全功能 API 层。

- common：鉴权/去重/RAG/免责/SSE 流式落盘等横向能力
- context：个人档案与八字/星座约束注入
- calculations：十一功能的确定性计算入口
- feature_routes：calc / deduce 动态路由工厂
- support_routes：历史、知识库统计、个人记忆端点

外层 `feature_api.py` 只做兼容门面，保持 `import feature_api` 的既有调用方式。
"""
