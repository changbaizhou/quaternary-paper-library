const taxonomy = {
  themes: [
    ["lake sediment", ["lake sediment", "lacustrine", "湖泊沉积", "湖芯"]],
    ["paleoclimate", ["paleoclimate", "palaeoclimate", "古气候", "climate change"]],
    ["paleoenvironment", ["paleoenvironment", "palaeoenvironment", "古环境"]],
    ["loess", ["loess", "黄土"]],
    ["glacier", ["glacier", "glacial", "ice sheet", "冰川"]],
    ["stratigraphy", ["stratigraphy", "strata", "地层"]],
    ["chronology", ["chronology", "dating", "年代学", "age model"]],
    ["sea level", ["sea level", "海平面"]],
    ["fluvial terrace", ["fluvial terrace", "river terrace", "河流阶地"]],
    ["tectonic-climate interaction", ["tectonic", "构造", "uplift"]]
  ],
  regions: [
    ["Qinghai-Tibet Plateau", ["qinghai-tibet plateau", "tibetan plateau", "青藏高原", "qtp"]],
    ["Loess Plateau", ["loess plateau", "黄土高原"]],
    ["East Asian monsoon region", ["east asian monsoon", "东亚季风"]],
    ["Northwest China arid region", ["northwest china", "arid central asia", "西北干旱区"]],
    ["Yangtze River basin", ["yangtze", "长江"]],
    ["North China Plain", ["north china plain", "华北平原"]],
    ["coastal shelf", ["coastal shelf", "continental shelf", "陆架"]],
    ["global comparison", ["global", "worldwide", "全球"]]
  ],
  periods: [
    ["Quaternary", ["quaternary", "第四纪"]],
    ["Pleistocene", ["pleistocene", "更新世"]],
    ["Holocene", ["Holocene", "全新世"]],
    ["Late Quaternary", ["late quaternary", "晚第四纪"]],
    ["Last Glacial Maximum", ["last glacial maximum", "lgm", "末次盛冰期", "末次冰盛期"]],
    ["Younger Dryas", ["younger dryas", "新仙女木"]],
    ["MIS stages", ["mis ", "marine isotope stage", "oxygen isotope stage"]]
  ],
  materials: [
    ["lake core", ["lake core", "sediment core", "湖芯", "core from"]],
    ["loess section", ["loess section", "黄土剖面"]],
    ["stalagmite", ["stalagmite", "speleothem", "石笋"]],
    ["ice core", ["ice core", "冰芯"]],
    ["marine sediment", ["marine sediment", "海洋沉积"]],
    ["fluvial terrace", ["fluvial terrace", "river terrace", "河流阶地"]],
    ["archaeological site", ["archaeological site", "考古遗址"]]
  ],
  methods: [
    ["OSL", ["osl", "optically stimulated luminescence", "光释光"]],
    ["radiocarbon", ["radiocarbon", "14c", "c-14", "碳十四"]],
    ["U-series", ["u-series", "uranium-series", "230th", "铀系"]],
    ["cosmogenic nuclide", ["cosmogenic", "10be", "26al", "宇生核素"]],
    ["pollen", ["pollen", "孢粉"]],
    ["grain size", ["grain size", "particle size", "粒度"]],
    ["magnetic susceptibility", ["magnetic susceptibility", "磁化率"]],
    ["stable isotope", ["stable isotope", "δ18o", "delta18o", "delta 18o", "稳定同位素"]],
    ["geochemistry", ["geochemistry", "element", "元素地球化学"]],
    ["biomarker", ["biomarker", "生物标志物"]],
    ["remote sensing GIS", ["remote sensing", "gis", "遥感"]]
  ],
  proxies: [
    ["pollen", ["pollen", "孢粉"]],
    ["phytolith", ["phytolith", "植硅体"]],
    ["diatom", ["diatom", "硅藻"]],
    ["ostracod", ["ostracod", "介形虫"]],
    ["charcoal", ["charcoal", "炭屑"]],
    ["grain size", ["grain size", "粒度"]],
    ["magnetic susceptibility", ["magnetic susceptibility", "磁化率"]],
    ["delta18O", ["δ18o", "delta18o", "delta 18o"]],
    ["delta13C", ["δ13c", "delta13c", "delta 13c"]],
    ["TOC", ["toc", "total organic carbon", "总有机碳"]],
    ["carbonate", ["carbonate", "碳酸盐"]],
    ["elements", ["elements", "xrf", "元素"]]
  ]
};

function countMatches(haystack, aliases) {
  const evidence = [];
  for (const alias of aliases) {
    const normalizedAlias = alias.toLowerCase();
    if (haystack.includes(normalizedAlias)) {
      evidence.push(alias);
    }
  }
  return evidence;
}

export function classifyText({ title = "", abstract = "", keywords = [], text = "" } = {}) {
  const joined = [title, abstract, keywords.join(" "), text.slice(0, 8000)]
    .join(" ")
    .toLowerCase();
  const classification = {};
  const confidence = {};
  const evidence = {};

  for (const [dimension, entries] of Object.entries(taxonomy)) {
    classification[dimension] = [];
    confidence[dimension] = {};
    evidence[dimension] = {};

    for (const [label, aliases] of entries) {
      const matches = countMatches(joined, aliases);
      if (matches.length > 0) {
        classification[dimension].push(label);
        confidence[dimension][label] = Math.min(0.98, 0.52 + matches.length * 0.12);
        evidence[dimension][label] = matches;
      }
    }
  }

  return { classification, confidence, evidence };
}

export function getTaxonomy() {
  return taxonomy;
}
