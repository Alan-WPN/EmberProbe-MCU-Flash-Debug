"use strict";

// 采样回调的纯数据层：同一份原始字节按图表/侧边栏各自类型解码，
// 并维护两个消费者的最新值。会话生命周期由 Provider 组装。
class LiveWatchService {
    constructor(elfSymbols) {
        this.elfSymbols = elfSymbols;
        this.latestGraphSamples = new Map();
        this.latestSidebarSamples = new Map();
    }

    decodeSamples(samples, time, types, compositeMap) {
        const graphSamples = [];
        const sidebarSamples = [];
        const compositeSamples = [];
        for (const sample of samples) {
            const composite = compositeMap.get(sample.name);
            if (composite && sample.bytes) {
                const tree = this.elfSymbols.decodeComposite(sample.bytes, composite.layout);
                if (tree) {
                    const decoded = { name: sample.name, tree, t: time };
                    compositeSamples.push(decoded);
                    this.latestSidebarSamples.set(sample.name, decoded);
                }
                continue;
            }
            const graphType = types.graph.get(sample.name);
            const sidebarType = types.sidebar.get(sample.name);
            if (graphType) {
                const decoded = {
                    name: sample.name,
                    value: sample.bytes ? this.elfSymbols.decodeValue(sample.bytes, graphType) : null,
                    t: time
                };
                graphSamples.push(decoded);
                this.latestGraphSamples.set(sample.name, decoded);
            }
            if (sidebarType) {
                const decoded = {
                    name: sample.name,
                    value: sample.bytes ? this.elfSymbols.decodeValue(sample.bytes, sidebarType) : null,
                    t: time
                };
                sidebarSamples.push(decoded);
                this.latestSidebarSamples.set(sample.name, decoded);
            }
        }
        return { graphSamples, sidebarSamples, compositeSamples };
    }

    prune(map, names) {
        const keep = new Set(names);
        for (const name of map.keys()) if (!keep.has(name)) map.delete(name);
    }
}

module.exports = { LiveWatchService };
