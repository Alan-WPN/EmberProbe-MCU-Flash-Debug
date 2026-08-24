"use strict";

const { AgentService } = require("./agentService");

// Agent 入口编排边界：继承经过安全过滤的 Bridge 生命周期与路由，
// Provider 只注入领域 handler，不直接构造/管理 AgentBridge。
class AgentOrchestrator extends AgentService {}

module.exports = { AgentOrchestrator };
