"""全功能 API 兼容门面。

路由与横向能力已按职责拆到 `server/features/`：
- common / context / calculations：可复用能力
- feature_routes / support_routes：路由注册
这里保留原有 `feature_api.router`、`feature_api._with_disclaimer` 等导出，
让 main.py 与既有脚本无需改动即可继续工作。
"""
from __future__ import annotations

from fastapi import APIRouter

from features import calculations, common, context
from features.feature_routes import router as feature_router
from features.support_routes import router as support_router

router = APIRouter()
router.include_router(feature_router)
router.include_router(support_router)

FEATURES = common.FEATURES

# 供 main.py / 测试 / 外部脚本按旧名字引用
_auth = common.auth
_retrieve = common.retrieve
_dedupe_key = common.dedupe_key
_with_disclaimer = common.with_disclaimer
_sse_replay = common.sse_replay

_birth_of_params = context.birth_of_params
_bazi_of_profile = context.bazi_of_profile
_bazi_of_params = context.bazi_of_params
_star_of_profile = context.star_of_profile
_bazi_complete = context.bazi_complete
_augment_profile = context.augment_profile
_personalize = context.personalize

_calc_meihua = calculations.calc_meihua
_calc_bazi = calculations.calc_bazi
_calc_huangli = calculations.calc_huangli
_calc_tarot = calculations.calc_tarot
_calc_bazi_marriage = calculations.calc_bazi_marriage
_calc_ziwei_marriage = calculations.calc_ziwei_marriage
_calc_astrology_marriage = calculations.calc_astrology_marriage
_calc_liuyao = calculations.calc_liuyao
_calc_qimen = calculations.calc_qimen
_calc_astrology = calculations.calc_astrology
_person_params = calculations.person_params

__all__ = ["router", "FEATURES", "_with_disclaimer", "_retrieve"]
