'use strict';

/**
 * Data aggregation — processes raw records into dashboard-ready summaries.
 */

function aggregate(records, pricing) {
  const byModel = {};
  let totalCost = 0, totalPrompt = 0, totalCompletion = 0, totalRequests = 0;
  const byDate = {};
  const bySource = {};

  records.forEach((r) => {
    // Aggregate by model
    if (!byModel[r.model]) {
      byModel[r.model] = {
        cost: 0, promptTokens: 0, completionTokens: 0, requests: 0,
        name: r.modelName, sources: new Set(),
      };
    }
    byModel[r.model].cost += r.cost;
    byModel[r.model].promptTokens += r.promptTokens;
    byModel[r.model].completionTokens += r.completionTokens;
    byModel[r.model].requests += r.requests;
    byModel[r.model].sources.add(r.billingPath);

    // By date
    if (r.date && r.date !== 'unknown') {
      if (!byDate[r.date]) byDate[r.date] = {};
      if (!byDate[r.date][r.model]) byDate[r.date][r.model] = 0;
      byDate[r.date][r.model] += r.cost;
    }

    // By billing path
    if (!bySource[r.billingPath]) bySource[r.billingPath] = { cost: 0, requests: 0, tokens: 0 };
    bySource[r.billingPath].cost += r.cost;
    bySource[r.billingPath].requests += r.requests;
    bySource[r.billingPath].tokens += r.promptTokens + r.completionTokens;

    totalCost += r.cost;
    totalPrompt += r.promptTokens;
    totalCompletion += r.completionTokens;
    totalRequests += r.requests;
  });

  const modelRanking = Object.entries(byModel)
    .map(([id, d]) => ({
      id, name: d.name, cost: d.cost, promptTokens: d.promptTokens,
      completionTokens: d.completionTokens, requests: d.requests,
      totalTokens: d.promptTokens + d.completionTokens,
      sources: [...d.sources].join(', '),
    }))
    .sort((a, b) => b.cost - a.cost);

  // Most expensive model by unit rate (for counterfactual)
  let maxUnitRate = 0, maxRateModel = 'unknown', maxRateModelName = 'unknown';
  modelRanking.forEach((m) => {
    const p = pricing[m.id];
    if (p) {
      const rate = p.completion || p.prompt || 0;
      if (rate > maxUnitRate) {
        maxUnitRate = rate;
        maxRateModel = m.id;
        maxRateModelName = m.name;
      }
    }
  });

  // Counterfactual — what if all tokens went through the most expensive model?
  let counterfactualCost = 0;
  if (maxUnitRate > 0 && pricing[maxRateModel]) {
    const exp = pricing[maxRateModel];
    modelRanking.forEach((m) => {
      counterfactualCost += m.promptTokens * exp.prompt + m.completionTokens * exp.completion;
    });
  }
  if (counterfactualCost < totalCost) counterfactualCost = totalCost;

  const routingSavings = counterfactualCost - totalCost;
  const costReduction = counterfactualCost > 0 ? routingSavings / counterfactualCost : 0;

  const sortedDates = Object.keys(byDate).sort();
  const chartData = sortedDates.map((date) => ({
    date,
    models: byDate[date],
    total: Object.values(byDate[date]).reduce((s, v) => s + v, 0),
  }));

  return {
    totalCost,
    totalPromptTokens: totalPrompt,
    totalCompletionTokens: totalCompletion,
    totalRequests,
    modelRanking,
    chartData,
    bySource,
    counterfactualCost,
    routingSavings,
    costReduction,
    maxRateModel,
    maxRateModelName,
    avgCostPerRequest: totalRequests > 0 ? totalCost / totalRequests : 0,
    activeModels: modelRanking.filter((m) => m.requests > 0).length,
    providers: [...new Set(modelRanking.map((m) => m.id.split('/')[0]))].length,
  };
}

module.exports = { aggregate };
