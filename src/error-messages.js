export const errorMessageDefinitions = Object.freeze([
  { key: 'invalid_client_key', label: '下游密钥无效', status: 401, defaultValue: '下游访问密钥无效' },
  { key: 'missing_client_key', label: '缺少下游密钥', status: 401, defaultValue: '缺少下游访问密钥' },
  { key: 'no_client_keys', label: '未配置下游密钥', status: 503, defaultValue: '尚未配置下游访问密钥，请先登录 /admin 创建' },
  { key: 'whitelist_denied', label: '白名单拦截', status: 403, defaultValue: '公益模型仅限在RP-Hub官方源站使用，如您再次尝试不合规请求，账号将遭到封禁，请切换付费分组或转至官方源站使用' },
  { key: 'client_overloaded', label: '下游并发超限', status: 503, defaultValue: '当前公益模型负载较高，暂时超出配额，请切换模型或稍后重试' },
  { key: 'invalid_json', label: 'JSON 请求体无效', status: 400, defaultValue: 'JSON 请求体无效' },
  { key: 'request_too_large', label: '请求体过大', status: 413, defaultValue: '请求体过大' },
  { key: 'model_required', label: '缺少模型名', status: 400, defaultValue: 'model 不能为空' },
  { key: 'model_not_found', label: '模型不存在', status: 404, defaultValue: '模型不存在：{model}' },
  { key: 'endpoint_not_found', label: '代理接口不存在', status: 404, defaultValue: '接口不存在' },
  { key: 'route_not_found', label: '根路由不存在', status: 404, defaultValue: 'Not found' },
  { key: 'api_unavailable', label: 'API 暂时不可用', status: 502, defaultValue: 'API 暂时不可用' },
  { key: 'internal_error', label: '服务器内部错误', status: 500, defaultValue: 'Internal server error' },
]);

export const defaultErrorMessages = Object.freeze(Object.fromEntries(
  errorMessageDefinitions.map((item) => [item.key, item.defaultValue]),
));

export const formatErrorMessage = (value, variables = {}) => String(value).replace(/\{(\w+)\}/g, (match, key) => (
  Object.hasOwn(variables, key) ? String(variables[key]) : match
));
