(function() {
  "use strict";

  // ─── CSS.escape polyfill (for environments without it) ───

  var cssEscape = (typeof CSS !== "undefined" && CSS.escape)
    ? CSS.escape.bind(CSS)
    : function(value) {
        var str = String(value);
        var length = str.length;
        var result = "";
        for (var i = 0; i < length; i++) {
          var ch = str.charCodeAt(i);
          if (ch === 0) { result += "\\ufffd"; continue; }
          if (
            (ch >= 0x0001 && ch <= 0x001F) || ch === 0x007F ||
            (i === 0 && ch >= 0x0030 && ch <= 0x0039) ||
            (i === 1 && ch >= 0x0030 && ch <= 0x0039 &&
              str.charCodeAt(0) === 0x002D)
          ) {
            result += "\\\\" + ch.toString(16) + " ";
            continue;
          }
          if (i === 0 && length === 1 && ch === 0x002D) {
            result += "\\\\" + str.charAt(i);
            continue;
          }
          if (
            ch >= 0x0080 ||
            ch === 0x002D || ch === 0x005F ||
            (ch >= 0x0030 && ch <= 0x0039) ||
            (ch >= 0x0041 && ch <= 0x005A) ||
            (ch >= 0x0061 && ch <= 0x007A)
          ) {
            result += str.charAt(i);
            continue;
          }
          result += "\\\\" + str.charAt(i);
        }
        return result;
      };

  // ─── CSS Selector Generator (Chrome DevTools algorithm) ───

  function getClassNames(element) {
    var classAttr = element.getAttribute("class");
    if (!classAttr) return [];
    return classAttr.split(/\s+/).filter(Boolean);
  }

  function idSelector(id) {
    return "#" + cssEscape(id);
  }

  function getCssSelectorStep(element, optimized, isTargetNode) {
    if (!(element instanceof Element)) return null;

    var id = element.id;
    var nodeName = element.localName;

    if (optimized && id) {
      return { value: idSelector(id), optimized: true };
    }

    if (optimized && (nodeName === "body" || nodeName === "head" || nodeName === "html")) {
      return { value: nodeName, optimized: true };
    }

    if (id) {
      return { value: nodeName + idSelector(id), optimized: true };
    }

    var parent = element.parentElement;

    if (!parent || element.parentNode === document) {
      return { value: nodeName, optimized: true };
    }

    var ownClassNames = getClassNames(element);
    var needsClassNames = false;
    var needsNthChild = false;
    var ownIndex = -1;
    var elementIndex = -1;
    var siblings = parent.children;

    for (var i = 0; i < siblings.length && (ownIndex === -1 || !needsNthChild); i++) {
      var sibling = siblings[i];
      elementIndex++;

      if (sibling === element) {
        ownIndex = elementIndex;
        continue;
      }

      if (needsNthChild) continue;

      if (sibling.localName !== nodeName) continue;

      needsClassNames = true;

      if (ownClassNames.length === 0) {
        needsNthChild = true;
        continue;
      }

      var siblingClassNames = new Set(getClassNames(sibling));
      var uniqueClasses = ownClassNames.filter(function(c) {
        return !siblingClassNames.has(c);
      });

      if (uniqueClasses.length === 0) {
        needsNthChild = true;
      }
    }

    var result = nodeName;

    if (
      isTargetNode &&
      nodeName === "input" &&
      element.getAttribute("type") &&
      !id &&
      ownClassNames.length === 0
    ) {
      result += "[type=" + cssEscape(element.getAttribute("type")) + "]";
    }

    if (needsNthChild) {
      result += ":nth-child(" + (ownIndex + 1) + ")";
    } else if (needsClassNames && ownClassNames.length > 0) {
      for (var ci = 0; ci < ownClassNames.length; ci++) {
        result += "." + cssEscape(ownClassNames[ci]);
      }
    }

    return { value: result, optimized: false };
  }

  function getCssSelector(element) {
    if (!(element instanceof Element)) return "";

    var steps = [];
    var currentElement = element;

    while (currentElement) {
      var step = getCssSelectorStep(
        currentElement,
        true,
        currentElement === element
      );
      if (!step) break;

      steps.push(step);

      if (step.optimized) break;

      currentElement = currentElement.parentElement;
    }

    steps.reverse();
    return steps.map(function(s) { return s.value; }).join(" > ");
  }

  // ─── Layout Detection ───

  function getOverlapArea(a, b) {
    var xOverlap = Math.max(
      0,
      Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
    );
    var yOverlap = Math.max(
      0,
      Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
    );
    return xOverlap * yOverlap;
  }

  function hasSignificantOverlap(boxes) {
    for (var i = 0; i < boxes.length; i++) {
      for (var j = i + 1; j < boxes.length; j++) {
        var overlapArea = getOverlapArea(boxes[i], boxes[j]);
        var smallerArea = Math.min(
          boxes[i].width * boxes[i].height,
          boxes[j].width * boxes[j].height
        );
        if (smallerArea > 0 && overlapArea / smallerArea > 0.5) {
          return true;
        }
      }
    }
    return false;
  }

  function detectLayout(boxes) {
    if (boxes.length < 2) return undefined;

    if (hasSignificantOverlap(boxes)) return undefined;

    var sorted = boxes.slice().sort(function(a, b) { return a.y - b.y; });

    var minHeight = Infinity;
    for (var mi = 0; mi < sorted.length; mi++) {
      if (sorted[mi].height < minHeight) minHeight = sorted[mi].height;
    }
    var tolerance = minHeight * 0.5;

    var rows = [];
    var currentRow = [sorted[0]];

    for (var i = 1; i < sorted.length; i++) {
      if (Math.abs(sorted[i].y - currentRow[0].y) <= tolerance) {
        currentRow.push(sorted[i]);
      } else {
        rows.push(currentRow);
        currentRow = [sorted[i]];
      }
    }
    rows.push(currentRow);

    var maxCols = 0;
    for (var ri = 0; ri < rows.length; ri++) {
      if (rows[ri].length > maxCols) maxCols = rows[ri].length;
    }
    if (maxCols < 2) return undefined;

    return maxCols + "x" + rows.length;
  }

  // ─── Color Comparison (CIELAB) ───

  function parseRgb(color) {
    var match = color.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  }

  function rgbToLab(rgb) {
    function toLinear(c) {
      var s = c / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    }
    var rl = toLinear(rgb[0]);
    var gl = toLinear(rgb[1]);
    var bl = toLinear(rgb[2]);

    var x = 0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl;
    var y = 0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl;
    var z = 0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl;

    x /= 0.95047;
    y /= 1.0;
    z /= 1.08883;

    function f(t) {
      return t > 0.008856 ? Math.pow(t, 1 / 3) : 7.787 * t + 16 / 116;
    }

    var L = 116 * f(y) - 16;
    var a = 500 * (f(x) - f(y));
    var bVal = 200 * (f(y) - f(z));

    return [L, a, bVal];
  }

  function deltaE(color1, color2) {
    var rgb1 = parseRgb(color1);
    var rgb2 = parseRgb(color2);
    if (!rgb1 || !rgb2) return Infinity;

    var lab1 = rgbToLab(rgb1);
    var lab2 = rgbToLab(rgb2);

    return Math.sqrt(
      Math.pow(lab1[0] - lab2[0], 2) +
      Math.pow(lab1[1] - lab2[1], 2) +
      Math.pow(lab1[2] - lab2[2], 2)
    );
  }

  // ─── Visual Tree Builder ───

  function getDirectTextContent(element) {
    var text = "";
    var nodes = element.childNodes;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].nodeType === Node.TEXT_NODE) {
        text += (nodes[i].textContent || "")
          .replace(/[\n\r\t]+/g, " ") + " ";
      }
    }
    return text.replace(/\s{2,}/g, " ").trim();
  }

  function buildVisualNode(element, minWidth) {
    if (element.id && element.id.indexOf("vibe-blueprint-") === 0) {
      return {
        tag: element.tagName,
        selector: element.tagName.toLowerCase(),
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        children: []
      };
    }

    var rect = element.getBoundingClientRect();
    var scrollY = window.scrollY;
    var scrollX = window.scrollX;

    var style = window.getComputedStyle(element);

    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      return {
        tag: element.tagName,
        selector: element.tagName.toLowerCase(),
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        children: []
      };
    }

    var selector = getCssSelector(element);

    var node = {
      tag: element.tagName,
      selector: selector,
      bounds: {
        x: Math.round(rect.left + scrollX),
        y: Math.round(rect.top + scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      children: []
    };

    if (element.id) {
      node.id = element.id;
    }

    if (element.classList.length > 0) {
      node.className = element.classList[0];
    }

    var role = element.getAttribute("role");
    if (role) {
      node.role = role;
    }

    var textContent = getDirectTextContent(element);
    if (textContent) {
      node.text = textContent.slice(0, 30);
    }

    var bgImage = style.backgroundImage;
    var bgColor = style.backgroundColor;
    var bgRaw = style.background;

    if (bgImage && bgImage !== "none") {
      if (bgImage.indexOf("gradient(") !== -1) {
        node.background = {
          type: "gradient",
          value: bgImage,
          raw: bgRaw,
          source: "css"
        };
      } else if (bgImage.indexOf("url(") !== -1) {
        var urlMatch = bgImage.match(/url\(["']?(.+?)["']?\)/);
        var url = urlMatch ? urlMatch[1] : bgImage;
        node.background = {
          type: "image",
          value: url,
          raw: bgRaw,
          source: "css"
        };
      }
    }

    if (
      !node.background &&
      bgColor &&
      bgColor !== "rgba(0, 0, 0, 0)" &&
      bgColor !== "transparent"
    ) {
      node.background = {
        type: "color",
        value: bgColor,
        raw: bgRaw,
        source: "css"
      };
    }

    if (!node.background) {
      var parentArea = rect.width * rect.height;
      if (parentArea > 0) {
        var elChildren = element.children;
        for (var ci = 0; ci < elChildren.length; ci++) {
          var child = elChildren[ci];
          if (child.tagName !== "IMG") continue;
          var imgRect = child.getBoundingClientRect();
          var imgArea = imgRect.width * imgRect.height;
          if (imgArea / parentArea >= 0.75) {
            var src = child.getAttribute("src") || "";
            node.background = {
              type: "image",
              value: src,
              raw: "",
              source: "img"
            };
            break;
          }
        }
      }
    }

    var elChildren2 = element.children;
    for (var chi = 0; chi < elChildren2.length; chi++) {
      var childEl = elChildren2[chi];
      var childRect = childEl.getBoundingClientRect();
      if (childRect.width >= minWidth) {
        var childNode = buildVisualNode(childEl, minWidth);
        if (childNode.bounds.width > 0 || childNode.children.length > 0) {
          node.children.push(childNode);
        }
      }
    }

    var allChildBoxes = [];
    for (var aci = 0; aci < elChildren2.length; aci++) {
      var acChild = elChildren2[aci];
      if (acChild.id && acChild.id.indexOf("vibe-blueprint-") === 0) continue;
      var acStyle = window.getComputedStyle(acChild);
      var hidden =
        acStyle.display === "none" ||
        acStyle.visibility === "hidden" ||
        acStyle.opacity === "0";
      if (hidden) continue;
      var acRect = acChild.getBoundingClientRect();
      if (acRect.width > 0 && acRect.height > 0) {
        allChildBoxes.push({
          x: Math.round(acRect.left + scrollX),
          y: Math.round(acRect.top + scrollY),
          width: Math.round(acRect.width),
          height: Math.round(acRect.height)
        });
      }
    }
    var layout = detectLayout(allChildBoxes);
    if (layout) {
      node.layout = layout;
    }

    if (node.children.length === 0 && !node.text) {
      var fullText = (element.textContent || "")
        .replace(/[\n\r\t]+/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (fullText) {
        node.text = fullText.slice(0, 30);
      }
    }

    if (
      (node.bounds.width === 0 || node.bounds.height === 0) &&
      node.children.length === 0
    ) {
      return {
        tag: element.tagName,
        selector: element.tagName.toLowerCase(),
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        children: []
      };
    }

    return node;
  }

  // ─── Tree Optimization ───

  function collapseSingleChildren(node) {
    for (var i = 0; i < node.children.length; i++) {
      collapseSingleChildren(node.children[i]);
    }

    while (node.children.length === 1) {
      var child = node.children[0];
      if (!node.text && child.text) {
        node.text = child.text;
      }
      if (!node.layout && child.layout) {
        node.layout = child.layout;
      }
      if (!node.background && child.background) {
        node.background = child.background;
      }
      node.children = child.children;
    }
  }

  // ─── Positional ID Assignment ───

  function assignPositionalIds(node, prefix, nodeMap) {
    nodeMap[prefix] = node.selector;
    for (var i = 0; i < node.children.length; i++) {
      var childId = prefix + "c" + (i + 1);
      assignPositionalIds(node.children[i], childId, nodeMap);
    }
  }

  // ─── Text Formatting ───

  var DELTA_E_THRESHOLD = 5;

  function formatTreeAsText(node, depth, nodeId, rootBackground) {
    var indent = "";
    for (var di = 0; di < depth; di++) indent += "  ";

    var descriptor = nodeId;
    if (node.role) descriptor += " [" + node.role + "]";
    if (node.layout) descriptor += " [" + node.layout + "]";
    if (node.background) {
      var skipInText =
        node.background.type === "color" &&
        rootBackground !== undefined &&
        deltaE(node.background.value, rootBackground) < DELTA_E_THRESHOLD;
      if (!skipInText) {
        descriptor += " [bg:" + node.background.type + "]";
      }
    }

    descriptor += " @" + node.bounds.x + "," + node.bounds.y;
    descriptor += " " + node.bounds.width + "x" + node.bounds.height;

    if (node.text) {
      descriptor +=
        ' "' + node.text + (node.text.length >= 30 ? "..." : "") + '"';
    }

    var result = indent + descriptor + "\n";

    for (var i = 0; i < node.children.length; i++) {
      var childId = nodeId + "c" + (i + 1);
      result += formatTreeAsText(
        node.children[i],
        depth + 1,
        childId,
        rootBackground
      );
    }

    return result;
  }

  // ─── Root Background Detection ───

  function isDefaultBackground(bg) {
    if (bg.type !== "color") return false;
    var v = bg.value;
    return (
      v === "rgba(0, 0, 0, 0)" ||
      v === "transparent" ||
      v === "rgb(255, 255, 255)"
    );
  }

  function detectRootBackground() {
    var elements = [document.body, document.documentElement];

    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var style = window.getComputedStyle(el);
      var bgImage = style.backgroundImage;
      var bgColor = style.backgroundColor;
      var bgRaw = style.background;

      if (bgImage && bgImage !== "none") {
        if (bgImage.indexOf("gradient(") !== -1) {
          return {
            type: "gradient",
            value: bgImage,
            raw: bgRaw,
            source: "css"
          };
        }
        if (bgImage.indexOf("url(") !== -1) {
          var urlMatch = bgImage.match(/url\(["']?(.+?)["']?\)/);
          var url = urlMatch ? urlMatch[1] : bgImage;
          return {
            type: "image",
            value: url,
            raw: bgRaw,
            source: "css"
          };
        }
      }

      if (
        bgColor &&
        bgColor !== "rgba(0, 0, 0, 0)" &&
        bgColor !== "transparent" &&
        bgColor !== "rgb(255, 255, 255)"
      ) {
        return {
          type: "color",
          value: bgColor,
          raw: bgRaw,
          source: "css"
        };
      }
    }

    return undefined;
  }

  function resolvePageBackground(treeRootBg, directDetectionBg) {
    if (treeRootBg && !isDefaultBackground(treeRootBg)) {
      return treeRootBg;
    }
    return directDetectionBg;
  }

  // ─── Main: captureVisualTree ───

  var minWidth = 900;
  var root = buildVisualNode(document.body, minWidth);
  collapseSingleChildren(root);

  var nodeMap = {};
  assignPositionalIds(root, "r", nodeMap);

  var bodyBg = window.getComputedStyle(document.body).backgroundColor;
  var htmlBg = window.getComputedStyle(
    document.documentElement
  ).backgroundColor;
  var rootBackground =
    bodyBg && bodyBg !== "rgba(0, 0, 0, 0)" && bodyBg !== "transparent"
      ? bodyBg
      : htmlBg && htmlBg !== "rgba(0, 0, 0, 0)" && htmlBg !== "transparent"
        ? htmlBg
        : "rgb(255, 255, 255)";

  var text = formatTreeAsText(root, 0, "r", rootBackground);

  return {
    tree: root,
    text: text,
    nodeMap: nodeMap
  };
})();
