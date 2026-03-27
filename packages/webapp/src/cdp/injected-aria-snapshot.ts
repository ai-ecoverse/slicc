/**
 * Injected accessibility tree generation script.
 *
 * Ported from Playwright's ariaSnapshot.ts and roleUtils.ts.
 * Original source: https://github.com/microsoft/playwright
 *
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Modifications for SLICC:
 * - Condensed into a single self-contained injectable script string
 * - Removed incremental snapshot, codegen, ref tracking, and matching logic
 * - Simplified to output AccessibilityNode tree compatible with SLICC's types
 * - Removed CSS tokenizer dependency (simplified CSS content parsing)
 */

/**
 * A self-contained JavaScript string that can be injected into any page
 * via Runtime.evaluate to produce an accessibility tree.
 *
 * Returns a JSON-serializable tree of { role, name, value?, description?, children? }
 * compatible with SLICC's AccessibilityNode interface.
 */
export const INJECTED_ARIA_SNAPSHOT_SCRIPT = `(function() {
  'use strict';

  // ===== DOM Utilities =====

  function parentElementOrShadowHost(element) {
    if (element.parentElement) return element.parentElement;
    if (!element.parentNode) return undefined;
    if (element.parentNode.nodeType === 11 && element.parentNode.host)
      return element.parentNode.host;
    return undefined;
  }

  function enclosingShadowRootOrDocument(element) {
    var node = element;
    while (node.parentNode) node = node.parentNode;
    if (node.nodeType === 11 || node.nodeType === 9) return node;
    return undefined;
  }

  function closestCrossShadow(element, css) {
    while (element) {
      var closest = element.closest(css);
      if (closest) return closest;
      var parent = element;
      while (parent.parentElement) parent = parent.parentElement;
      element = parentElementOrShadowHost(parent);
    }
    return undefined;
  }

  function elementSafeTagName(element) {
    var tagName = element.tagName;
    if (typeof tagName === 'string') return tagName.toUpperCase();
    if (element instanceof HTMLFormElement) return 'FORM';
    return element.tagName.toUpperCase();
  }

  function getComputedStyleCached(element, pseudo) {
    if (!element.ownerDocument || !element.ownerDocument.defaultView) return undefined;
    return element.ownerDocument.defaultView.getComputedStyle(element, pseudo || null);
  }

  function isElementStyleVisibilityVisible(element, style) {
    style = style || getComputedStyleCached(element);
    if (!style) return true;
    if (typeof element.checkVisibility === 'function') {
      if (!element.checkVisibility()) return false;
    } else {
      var detailsOrSummary = element.closest('details,summary');
      if (detailsOrSummary !== element && detailsOrSummary &&
          detailsOrSummary.nodeName === 'DETAILS' && !detailsOrSummary.open)
        return false;
    }
    if (style.visibility !== 'visible') return false;
    return true;
  }

  function isVisibleTextNode(node) {
    var range = node.ownerDocument.createRange();
    range.selectNode(node);
    var rect = range.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isElementVisible(element) {
    var style = getComputedStyleCached(element);
    if (!style) return true;
    if (style.display === 'contents') {
      for (var child = element.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && isElementVisible(child)) return true;
        if (child.nodeType === 3 && isVisibleTextNode(child)) return true;
      }
      return false;
    }
    if (!isElementStyleVisibilityVisible(element, style)) return false;
    var rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ===== ARIA Role Utilities =====

  var kAncestorPreventingLandmark = 'article:not([role]), aside:not([role]), main:not([role]), nav:not([role]), section:not([role]), [role=article], [role=complementary], [role=main], [role=navigation], [role=region]';

  function hasExplicitAccessibleName(e) {
    return e.hasAttribute('aria-label') || e.hasAttribute('aria-labelledby');
  }

  var kGlobalAriaAttributes = [
    'aria-atomic', 'aria-busy', 'aria-controls', 'aria-current',
    'aria-describedby', 'aria-details', 'aria-dropeffect', 'aria-flowto',
    'aria-grabbed', 'aria-hidden', 'aria-keyshortcuts', 'aria-label',
    'aria-labelledby', 'aria-live', 'aria-owns', 'aria-relevant',
    'aria-roledescription'
  ];

  function hasGlobalAriaAttribute(element) {
    for (var i = 0; i < kGlobalAriaAttributes.length; i++) {
      if (element.hasAttribute(kGlobalAriaAttributes[i])) return true;
    }
    return false;
  }

  function hasTabIndex(element) {
    return !Number.isNaN(Number(String(element.getAttribute('tabindex'))));
  }

  function isNativelyDisabled(element) {
    var isNativeFormControl = ['BUTTON','INPUT','SELECT','TEXTAREA','OPTION','OPTGROUP'].indexOf(elementSafeTagName(element)) >= 0;
    return isNativeFormControl && (element.hasAttribute('disabled') || belongsToDisabledFieldSet(element));
  }

  function belongsToDisabledFieldSet(element) {
    var fieldSet = element.closest('FIELDSET[DISABLED]');
    if (!fieldSet) return false;
    var legend = fieldSet.querySelector(':scope > LEGEND');
    return !legend || !legend.contains(element);
  }

  function isFocusable(element) {
    return !isNativelyDisabled(element) && (isNativelyFocusable(element) || hasTabIndex(element));
  }

  function isNativelyFocusable(element) {
    var tagName = elementSafeTagName(element);
    if (['BUTTON','DETAILS','SELECT','TEXTAREA'].indexOf(tagName) >= 0) return true;
    if (tagName === 'A' || tagName === 'AREA') return element.hasAttribute('href');
    if (tagName === 'INPUT') return !element.hidden;
    return false;
  }

  function getIdRefs(element, ref) {
    if (!ref) return [];
    var root = enclosingShadowRootOrDocument(element);
    if (!root) return [];
    try {
      var ids = ref.split(' ').filter(function(id) { return !!id; });
      var result = [];
      for (var i = 0; i < ids.length; i++) {
        var el = root.querySelector('#' + CSS.escape(ids[i]));
        if (el && result.indexOf(el) < 0) result.push(el);
      }
      return result;
    } catch(e) { return []; }
  }

  var inputTypeToRole = {
    'button': 'button', 'checkbox': 'checkbox', 'image': 'button',
    'number': 'spinbutton', 'radio': 'radio', 'range': 'slider',
    'reset': 'button', 'submit': 'button'
  };

  var kImplicitRoleByTagName = {
    'A': function(e) { return e.hasAttribute('href') ? 'link' : null; },
    'AREA': function(e) { return e.hasAttribute('href') ? 'link' : null; },
    'ARTICLE': function() { return 'article'; },
    'ASIDE': function() { return 'complementary'; },
    'BLOCKQUOTE': function() { return 'blockquote'; },
    'BUTTON': function() { return 'button'; },
    'CAPTION': function() { return 'caption'; },
    'CODE': function() { return 'code'; },
    'DATALIST': function() { return 'listbox'; },
    'DD': function() { return 'definition'; },
    'DEL': function() { return 'deletion'; },
    'DETAILS': function() { return 'group'; },
    'DFN': function() { return 'term'; },
    'DIALOG': function() { return 'dialog'; },
    'DT': function() { return 'term'; },
    'EM': function() { return 'emphasis'; },
    'FIELDSET': function() { return 'group'; },
    'FIGURE': function() { return 'figure'; },
    'FOOTER': function(e) { return closestCrossShadow(e, kAncestorPreventingLandmark) ? null : 'contentinfo'; },
    'FORM': function(e) { return hasExplicitAccessibleName(e) ? 'form' : null; },
    'H1': function() { return 'heading'; },
    'H2': function() { return 'heading'; },
    'H3': function() { return 'heading'; },
    'H4': function() { return 'heading'; },
    'H5': function() { return 'heading'; },
    'H6': function() { return 'heading'; },
    'HEADER': function(e) { return closestCrossShadow(e, kAncestorPreventingLandmark) ? null : 'banner'; },
    'HR': function() { return 'separator'; },
    'HTML': function() { return 'document'; },
    'IMG': function(e) { return (e.getAttribute('alt') === '') && !e.getAttribute('title') && !hasGlobalAriaAttribute(e) && !hasTabIndex(e) ? 'presentation' : 'img'; },
    'INPUT': function(e) {
      var type = (e.type || '').toLowerCase();
      if (type === 'search') return e.hasAttribute('list') ? 'combobox' : 'searchbox';
      if (['email','tel','text','url',''].indexOf(type) >= 0) {
        var list = getIdRefs(e, e.getAttribute('list'))[0];
        return (list && elementSafeTagName(list) === 'DATALIST') ? 'combobox' : 'textbox';
      }
      if (type === 'hidden') return null;
      if (type === 'file') return 'button';
      return inputTypeToRole[type] || 'textbox';
    },
    'INS': function() { return 'insertion'; },
    'LI': function() { return 'listitem'; },
    'MAIN': function() { return 'main'; },
    'MARK': function() { return 'mark'; },
    'MATH': function() { return 'math'; },
    'MENU': function() { return 'list'; },
    'METER': function() { return 'meter'; },
    'NAV': function() { return 'navigation'; },
    'OL': function() { return 'list'; },
    'OPTGROUP': function() { return 'group'; },
    'OPTION': function() { return 'option'; },
    'OUTPUT': function() { return 'status'; },
    'P': function() { return 'paragraph'; },
    'PROGRESS': function() { return 'progressbar'; },
    'SEARCH': function() { return 'search'; },
    'SECTION': function(e) { return hasExplicitAccessibleName(e) ? 'region' : null; },
    'SELECT': function(e) { return e.hasAttribute('multiple') || e.size > 1 ? 'listbox' : 'combobox'; },
    'STRONG': function() { return 'strong'; },
    'SUB': function() { return 'subscript'; },
    'SUP': function() { return 'superscript'; },
    'SVG': function() { return 'img'; },
    'TABLE': function() { return 'table'; },
    'TBODY': function() { return 'rowgroup'; },
    'TD': function(e) {
      var table = closestCrossShadow(e, 'table');
      var role = table ? getExplicitAriaRole(table) : '';
      return (role === 'grid' || role === 'treegrid') ? 'gridcell' : 'cell';
    },
    'TEXTAREA': function() { return 'textbox'; },
    'TFOOT': function() { return 'rowgroup'; },
    'TH': function(e) {
      var scope = e.getAttribute('scope');
      if (scope === 'col' || scope === 'colgroup') return 'columnheader';
      if (scope === 'row' || scope === 'rowgroup') return 'rowheader';
      return 'columnheader';
    },
    'THEAD': function() { return 'rowgroup'; },
    'TIME': function() { return 'time'; },
    'TR': function() { return 'row'; },
    'UL': function() { return 'list'; }
  };

  var validRoles = ['alert','alertdialog','application','article','banner','blockquote','button','caption','cell','checkbox','code','columnheader','combobox','complementary','contentinfo','definition','deletion','dialog','directory','document','emphasis','feed','figure','form','generic','grid','gridcell','group','heading','img','insertion','link','list','listbox','listitem','log','main','mark','marquee','math','meter','menu','menubar','menuitem','menuitemcheckbox','menuitemradio','navigation','none','note','option','paragraph','presentation','progressbar','radio','radiogroup','region','row','rowgroup','rowheader','scrollbar','search','searchbox','separator','slider','spinbutton','status','strong','subscript','superscript','switch','tab','table','tablist','tabpanel','term','textbox','time','timer','toolbar','tooltip','tree','treegrid','treeitem'];

  function getExplicitAriaRole(element) {
    var roles = (element.getAttribute('role') || '').split(' ').map(function(r) { return r.trim(); });
    for (var i = 0; i < roles.length; i++) {
      if (validRoles.indexOf(roles[i]) >= 0) return roles[i];
    }
    return null;
  }

  var kPresentationInheritanceParents = {
    'DD': ['DL','DIV'], 'DIV': ['DL'], 'DT': ['DL','DIV'], 'LI': ['OL','UL'],
    'TBODY': ['TABLE'], 'TD': ['TR'], 'TFOOT': ['TABLE'], 'TH': ['TR'],
    'THEAD': ['TABLE'], 'TR': ['THEAD','TBODY','TFOOT','TABLE']
  };

  function hasPresentationConflictResolution(element, role) {
    return hasGlobalAriaAttribute(element) || isFocusable(element);
  }

  function getImplicitAriaRole(element) {
    var fn = kImplicitRoleByTagName[elementSafeTagName(element)];
    var implicitRole = fn ? fn(element) : '';
    if (!implicitRole) return null;
    var ancestor = element;
    while (ancestor) {
      var parent = parentElementOrShadowHost(ancestor);
      var parents = kPresentationInheritanceParents[elementSafeTagName(ancestor)];
      if (!parents || !parent || parents.indexOf(elementSafeTagName(parent)) < 0) break;
      var parentExplicitRole = getExplicitAriaRole(parent);
      if ((parentExplicitRole === 'none' || parentExplicitRole === 'presentation') &&
          !hasPresentationConflictResolution(parent, parentExplicitRole))
        return parentExplicitRole;
      ancestor = parent;
    }
    return implicitRole;
  }

  function getAriaRole(element) {
    var explicitRole = getExplicitAriaRole(element);
    if (!explicitRole) return getImplicitAriaRole(element);
    if (explicitRole === 'none' || explicitRole === 'presentation') {
      var implicitRole = getImplicitAriaRole(element);
      if (hasPresentationConflictResolution(element, implicitRole)) return implicitRole;
    }
    return explicitRole;
  }

  // ===== Visibility / Hidden for ARIA =====

  function isElementIgnoredForAria(element) {
    return ['STYLE','SCRIPT','NOSCRIPT','TEMPLATE'].indexOf(elementSafeTagName(element)) >= 0;
  }

  function getAriaBoolean(attr) {
    return attr === null ? undefined : attr.toLowerCase() === 'true';
  }

  function belongsToDisplayNoneOrAriaHidden(element) {
    var style = getComputedStyleCached(element);
    if (!style || style.display === 'none' || getAriaBoolean(element.getAttribute('aria-hidden')) === true)
      return true;
    if (element.parentElement && element.parentElement.shadowRoot && !element.assignedSlot)
      return true;
    var parent = parentElementOrShadowHost(element);
    if (parent) return belongsToDisplayNoneOrAriaHidden(parent);
    return false;
  }

  function isElementHiddenForAria(element) {
    if (isElementIgnoredForAria(element)) return true;
    var style = getComputedStyleCached(element);
    var isSlot = element.nodeName === 'SLOT';
    if (style && style.display === 'contents' && !isSlot) {
      for (var child = element.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && !isElementHiddenForAria(child)) return false;
        if (child.nodeType === 3 && isVisibleTextNode(child)) return false;
      }
      return true;
    }
    var isOptionInsideSelect = element.nodeName === 'OPTION' && !!element.closest('select');
    if (!isOptionInsideSelect && !isSlot && !isElementStyleVisibilityVisible(element, style))
      return true;
    return belongsToDisplayNoneOrAriaHidden(element);
  }

  // ===== Accessible Name Computation (WAI-ARIA accname) =====

  function trimFlatString(s) { return s.trim(); }

  function asFlatString(s) {
    return s.replace(/\\r\\n/g, '\\n').replace(/[\\u200b\\u00ad]/g, '').replace(/\\s\\s*/g, ' ').trim();
  }

  function normalizeWhiteSpace(s) {
    if (!s) return '';
    return s.replace(/\\s+/g, ' ').trim();
  }

  function allowsNameFromContent(role, targetDescendant) {
    var always = ['button','cell','checkbox','columnheader','gridcell','heading','link','menuitem','menuitemcheckbox','menuitemradio','option','radio','row','rowheader','switch','tab','tooltip','treeitem'];
    if (always.indexOf(role) >= 0) return true;
    if (targetDescendant) {
      var descendant = ['','caption','code','contentinfo','definition','deletion','emphasis','insertion','list','listitem','mark','none','paragraph','presentation','region','row','rowgroup','section','strong','subscript','superscript','table','term','time'];
      if (descendant.indexOf(role) >= 0) return true;
    }
    return false;
  }

  function getAriaLabelledByElements(element) {
    var ref = element.getAttribute('aria-labelledby');
    if (ref === null) return null;
    var refs = getIdRefs(element, ref);
    return refs.length ? refs : null;
  }

  function queryInAriaOwned(element, selector) {
    var result = Array.from(element.querySelectorAll(selector));
    var owned = getIdRefs(element, element.getAttribute('aria-owns'));
    for (var i = 0; i < owned.length; i++) {
      if (owned[i].matches(selector)) result.push(owned[i]);
      result.push.apply(result, Array.from(owned[i].querySelectorAll(selector)));
    }
    return result;
  }

  function getCSSContent(element, pseudo) {
    var style = getComputedStyleCached(element, pseudo);
    if (!style) return undefined;
    var contentValue = style.content;
    if (!contentValue || contentValue === 'none' || contentValue === 'normal') return undefined;
    if (style.display === 'none' || style.visibility === 'hidden') return undefined;
    // Simple string content parsing - handles "text" and 'text'
    var match = contentValue.match(/^["'](.*)["']$/);
    if (match) {
      var content = match[1];
      if (pseudo) {
        var display = style.display || 'inline';
        if (display !== 'inline') content = ' ' + content + ' ';
      }
      return content;
    }
    return undefined;
  }

  function getTextAlternativeInternal(element, options) {
    if (options.visitedElements.has(element)) return '';

    var childOptions = Object.assign({}, options);
    childOptions.embeddedInTargetElement = options.embeddedInTargetElement === 'self' ? 'descendant' : options.embeddedInTargetElement;

    // Step 2a: Hidden not referenced
    if (!options.includeHidden) {
      var isEmbeddedInHiddenRef =
        (options.embeddedInLabelledBy && options.embeddedInLabelledBy.hidden) ||
        (options.embeddedInLabel && options.embeddedInLabel.hidden) ||
        (options.embeddedInNativeTextAlternative && options.embeddedInNativeTextAlternative.hidden);
      if (isElementIgnoredForAria(element) || (!isEmbeddedInHiddenRef && isElementHiddenForAria(element))) {
        options.visitedElements.add(element);
        return '';
      }
    }

    var labelledBy = getAriaLabelledByElements(element);

    // Step 2b: aria-labelledby
    if (!options.embeddedInLabelledBy && labelledBy) {
      var accessibleName = labelledBy.map(function(ref) {
        return getTextAlternativeInternal(ref, {
          includeHidden: options.includeHidden,
          visitedElements: options.visitedElements,
          embeddedInLabelledBy: { element: ref, hidden: isElementHiddenForAria(ref) }
        });
      }).join(' ');
      if (accessibleName) return accessibleName;
    }

    var role = getAriaRole(element) || '';
    var tagName = elementSafeTagName(element);

    // Step 2c/2d: Embedded controls
    if (options.embeddedInLabel || options.embeddedInLabelledBy || options.embeddedInTargetElement === 'descendant') {
      var labels = element.labels || [];
      var isOwnLabel = Array.from(labels).indexOf(element) >= 0;
      var isOwnLabelledBy = (labelledBy || []).indexOf(element) >= 0;
      if (!isOwnLabel && !isOwnLabelledBy) {
        if (role === 'textbox') {
          options.visitedElements.add(element);
          if (tagName === 'INPUT' || tagName === 'TEXTAREA') return element.value;
          return element.textContent || '';
        }
        if (role === 'combobox' || role === 'listbox') {
          options.visitedElements.add(element);
          var selectedOptions;
          if (tagName === 'SELECT') {
            selectedOptions = Array.from(element.selectedOptions);
            if (!selectedOptions.length && element.options.length)
              selectedOptions.push(element.options[0]);
          } else {
            var listbox = role === 'combobox' ? queryInAriaOwned(element, '*').find(function(e) { return getAriaRole(e) === 'listbox'; }) : element;
            selectedOptions = listbox ? queryInAriaOwned(listbox, '[aria-selected="true"]').filter(function(e) { return getAriaRole(e) === 'option'; }) : [];
          }
          if (!selectedOptions.length && tagName === 'INPUT') return element.value;
          return selectedOptions.map(function(opt) { return getTextAlternativeInternal(opt, childOptions); }).join(' ');
        }
        if (['progressbar','scrollbar','slider','spinbutton','meter'].indexOf(role) >= 0) {
          options.visitedElements.add(element);
          if (element.hasAttribute('aria-valuetext')) return element.getAttribute('aria-valuetext') || '';
          if (element.hasAttribute('aria-valuenow')) return element.getAttribute('aria-valuenow') || '';
          return element.getAttribute('value') || '';
        }
      }
    }

    // Step 2d: aria-label
    var ariaLabel = element.getAttribute('aria-label') || '';
    if (trimFlatString(ariaLabel)) {
      options.visitedElements.add(element);
      return ariaLabel;
    }

    // Step 2e: Native text alternatives
    if (['presentation','none'].indexOf(role) < 0) {
      if (tagName === 'INPUT' && ['button','submit','reset'].indexOf(element.type) >= 0) {
        options.visitedElements.add(element);
        var val = element.value || '';
        if (trimFlatString(val)) return val;
        if (element.type === 'submit') return 'Submit';
        if (element.type === 'reset') return 'Reset';
        return element.getAttribute('title') || '';
      }
      if (tagName === 'INPUT' && element.type === 'image') {
        options.visitedElements.add(element);
        var alt = element.getAttribute('alt') || '';
        if (trimFlatString(alt)) return alt;
        var title = element.getAttribute('title') || '';
        if (trimFlatString(title)) return title;
        return 'Submit';
      }
      if (!labelledBy && (tagName === 'TEXTAREA' || tagName === 'SELECT' || tagName === 'INPUT')) {
        options.visitedElements.add(element);
        var elLabels = element.labels || [];
        if (elLabels.length) {
          return Array.from(elLabels).map(function(label) {
            return getTextAlternativeInternal(label, Object.assign({}, childOptions, {
              embeddedInLabel: { element: label, hidden: isElementHiddenForAria(label) }
            }));
          }).filter(function(n) { return !!n; }).join(' ');
        }
        var usePlaceholder = (tagName === 'INPUT' && ['text','password','search','tel','email','url'].indexOf(element.type) >= 0) || tagName === 'TEXTAREA';
        var placeholder = element.getAttribute('placeholder') || '';
        var elTitle = element.getAttribute('title') || '';
        if (!usePlaceholder || elTitle) return elTitle;
        return placeholder;
      }
      if (!labelledBy && tagName === 'FIELDSET') {
        options.visitedElements.add(element);
        for (var child = element.firstElementChild; child; child = child.nextElementSibling) {
          if (elementSafeTagName(child) === 'LEGEND') {
            return getTextAlternativeInternal(child, Object.assign({}, childOptions, {
              embeddedInNativeTextAlternative: { element: child, hidden: isElementHiddenForAria(child) }
            }));
          }
        }
        return element.getAttribute('title') || '';
      }
      if (!labelledBy && tagName === 'FIGURE') {
        options.visitedElements.add(element);
        for (var child = element.firstElementChild; child; child = child.nextElementSibling) {
          if (elementSafeTagName(child) === 'FIGCAPTION') {
            return getTextAlternativeInternal(child, Object.assign({}, childOptions, {
              embeddedInNativeTextAlternative: { element: child, hidden: isElementHiddenForAria(child) }
            }));
          }
        }
        return element.getAttribute('title') || '';
      }
      if (tagName === 'IMG') {
        options.visitedElements.add(element);
        var imgAlt = element.getAttribute('alt') || '';
        if (trimFlatString(imgAlt)) return imgAlt;
        return element.getAttribute('title') || '';
      }
      if (tagName === 'TABLE') {
        options.visitedElements.add(element);
        for (var child = element.firstElementChild; child; child = child.nextElementSibling) {
          if (elementSafeTagName(child) === 'CAPTION') {
            return getTextAlternativeInternal(child, Object.assign({}, childOptions, {
              embeddedInNativeTextAlternative: { element: child, hidden: isElementHiddenForAria(child) }
            }));
          }
        }
        var summary = element.getAttribute('summary') || '';
        if (summary) return summary;
      }
      if (tagName === 'AREA') {
        options.visitedElements.add(element);
        var areaAlt = element.getAttribute('alt') || '';
        if (trimFlatString(areaAlt)) return areaAlt;
        return element.getAttribute('title') || '';
      }
      if (tagName === 'SVG' || element.ownerSVGElement) {
        options.visitedElements.add(element);
        for (var child = element.firstElementChild; child; child = child.nextElementSibling) {
          if (elementSafeTagName(child) === 'TITLE' && child.ownerSVGElement) {
            return getTextAlternativeInternal(child, Object.assign({}, childOptions, {
              embeddedInLabelledBy: { element: child, hidden: isElementHiddenForAria(child) }
            }));
          }
        }
      }
    }

    // Step 2f + 2h: Name from content
    var shouldNameFromContentForSummary = tagName === 'SUMMARY' && ['presentation','none'].indexOf(role) < 0;
    if (allowsNameFromContent(role, options.embeddedInTargetElement === 'descendant') ||
        shouldNameFromContentForSummary ||
        options.embeddedInLabelledBy || options.embeddedInLabel ||
        options.embeddedInNativeTextAlternative) {
      options.visitedElements.add(element);
      var accName = innerAccumulatedElementText(element, childOptions);
      var maybeTrimmed = options.embeddedInTargetElement === 'self' ? trimFlatString(accName) : accName;
      if (maybeTrimmed) return accName;
    }

    // Step 2i: title attribute
    if (['presentation','none'].indexOf(role) < 0 || tagName === 'IFRAME') {
      options.visitedElements.add(element);
      var titleAttr = element.getAttribute('title') || '';
      if (trimFlatString(titleAttr)) return titleAttr;
    }

    options.visitedElements.add(element);
    return '';
  }

  function innerAccumulatedElementText(element, options) {
    var tokens = [];
    var visit = function(node, skipSlotted) {
      if (skipSlotted && node.assignedSlot) return;
      if (node.nodeType === 1) {
        var display = (getComputedStyleCached(node) || {}).display || 'inline';
        var token = getTextAlternativeInternal(node, options);
        if (display !== 'inline' || node.nodeName === 'BR') token = ' ' + token + ' ';
        tokens.push(token);
      } else if (node.nodeType === 3) {
        tokens.push(node.textContent || '');
      }
    };
    tokens.push(getCSSContent(element, '::before') || '');
    var assignedNodes = element.nodeName === 'SLOT' ? element.assignedNodes() : [];
    if (assignedNodes.length) {
      for (var i = 0; i < assignedNodes.length; i++) visit(assignedNodes[i], false);
    } else {
      for (var child = element.firstChild; child; child = child.nextSibling) visit(child, true);
      if (element.shadowRoot) {
        for (var child = element.shadowRoot.firstChild; child; child = child.nextSibling) visit(child, true);
      }
      var owned = getIdRefs(element, element.getAttribute('aria-owns'));
      for (var i = 0; i < owned.length; i++) visit(owned[i], true);
    }
    tokens.push(getCSSContent(element, '::after') || '');
    return tokens.join('');
  }

  function getElementAccessibleName(element, includeHidden) {
    var elementProhibitsNaming = ['caption','code','definition','deletion','emphasis','generic','insertion','mark','paragraph','presentation','strong','subscript','suggestion','superscript','term','time'].indexOf(getAriaRole(element) || '') >= 0;
    if (elementProhibitsNaming) return '';
    return asFlatString(getTextAlternativeInternal(element, {
      includeHidden: includeHidden,
      visitedElements: new Set(),
      embeddedInTargetElement: 'self'
    }));
  }

  // ===== ARIA State Helpers =====

  var kAriaCheckedRoles = ['checkbox','menuitemcheckbox','option','radio','switch','menuitemradio','treeitem'];
  var kAriaDisabledRoles = ['application','button','composite','gridcell','group','input','link','menuitem','scrollbar','separator','tab','checkbox','columnheader','combobox','grid','listbox','menu','menubar','menuitemcheckbox','menuitemradio','option','radio','radiogroup','row','rowheader','searchbox','select','slider','spinbutton','switch','tablist','textbox','toolbar','tree','treegrid','treeitem'];
  var kAriaExpandedRoles = ['application','button','checkbox','combobox','gridcell','link','listbox','menuitem','row','rowheader','tab','treeitem','columnheader','menuitemcheckbox','menuitemradio','switch'];
  var kAriaLevelRoles = ['heading','listitem','row','treeitem'];
  var kAriaPressedRoles = ['button'];
  var kAriaSelectedRoles = ['gridcell','option','row','tab','rowheader','columnheader','treeitem'];

  function getAriaChecked(element) {
    var tagName = elementSafeTagName(element);
    if (tagName === 'INPUT' && element.indeterminate) return 'mixed';
    if (tagName === 'INPUT' && ['checkbox','radio'].indexOf(element.type) >= 0) return element.checked;
    if (kAriaCheckedRoles.indexOf(getAriaRole(element) || '') >= 0) {
      var checked = element.getAttribute('aria-checked');
      if (checked === 'true') return true;
      if (checked === 'mixed') return 'mixed';
      return false;
    }
    return false;
  }

  function getAriaDisabled(element) {
    if (isNativelyDisabled(element)) return true;
    var e = element;
    while (e) {
      if (kAriaDisabledRoles.indexOf(getAriaRole(e) || '') >= 0 || e !== element) {
        var attr = (e.getAttribute('aria-disabled') || '').toLowerCase();
        if (attr === 'true') return true;
        if (attr === 'false') return false;
      }
      e = parentElementOrShadowHost(e);
    }
    return false;
  }

  function getAriaExpanded(element) {
    if (elementSafeTagName(element) === 'DETAILS') return element.open;
    if (kAriaExpandedRoles.indexOf(getAriaRole(element) || '') >= 0) {
      var expanded = element.getAttribute('aria-expanded');
      if (expanded === null) return undefined;
      if (expanded === 'true') return true;
      return false;
    }
    return undefined;
  }

  function getAriaLevel(element) {
    var native = { 'H1': 1, 'H2': 2, 'H3': 3, 'H4': 4, 'H5': 5, 'H6': 6 }[elementSafeTagName(element)];
    if (native) return native;
    if (kAriaLevelRoles.indexOf(getAriaRole(element) || '') >= 0) {
      var attr = element.getAttribute('aria-level');
      var value = attr === null ? NaN : Number(attr);
      if (Number.isInteger(value) && value >= 1) return value;
    }
    return 0;
  }

  function getAriaPressed(element) {
    if (kAriaPressedRoles.indexOf(getAriaRole(element) || '') >= 0) {
      var pressed = element.getAttribute('aria-pressed');
      if (pressed === 'true') return true;
      if (pressed === 'mixed') return 'mixed';
    }
    return false;
  }

  function getAriaSelected(element) {
    if (elementSafeTagName(element) === 'OPTION') return element.selected;
    if (kAriaSelectedRoles.indexOf(getAriaRole(element) || '') >= 0)
      return getAriaBoolean(element.getAttribute('aria-selected')) === true;
    return false;
  }

  // ===== Tree Generation (from ariaSnapshot.ts) =====

  function generateAriaTree(rootElement) {
    var visited = new Set();
    var root = { role: 'RootWebArea', name: '', children: [] };

    function visit(ariaNode, node, parentElementVisible) {
      if (visited.has(node)) return;
      visited.add(node);

      if (node.nodeType === 3 && node.nodeValue) {
        if (!parentElementVisible) return;
        var text = node.nodeValue;
        if (ariaNode.role !== 'textbox' && text) ariaNode.children.push(text);
        return;
      }
      if (node.nodeType !== 1) return;

      var element = node;
      var visible = !isElementHiddenForAria(element);

      // If not visible for aria, skip entirely (including children)
      if (!visible) return;

      var ariaChildren = [];
      if (element.hasAttribute('aria-owns')) {
        var ids = element.getAttribute('aria-owns').split(/\\s+/);
        for (var i = 0; i < ids.length; i++) {
          var ownedElement = rootElement.ownerDocument.getElementById(ids[i]);
          if (ownedElement) ariaChildren.push(ownedElement);
        }
      }

      var childAriaNode = toAriaNode(element);
      if (childAriaNode) ariaNode.children.push(childAriaNode);
      processElement(childAriaNode || ariaNode, element, ariaChildren, visible);
    }

    function processElement(ariaNode, element, ariaChildren, parentElementVisible) {
      var display = (getComputedStyleCached(element) || {}).display || 'inline';
      var treatAsBlock = (display !== 'inline' || element.nodeName === 'BR') ? ' ' : '';
      if (treatAsBlock) ariaNode.children.push(treatAsBlock);

      ariaNode.children.push(getCSSContent(element, '::before') || '');
      var assignedNodes = element.nodeName === 'SLOT' ? element.assignedNodes() : [];
      if (assignedNodes.length) {
        for (var i = 0; i < assignedNodes.length; i++) visit(ariaNode, assignedNodes[i], parentElementVisible);
      } else {
        for (var child = element.firstChild; child; child = child.nextSibling) {
          if (!child.assignedSlot) visit(ariaNode, child, parentElementVisible);
        }
        if (element.shadowRoot) {
          for (var child = element.shadowRoot.firstChild; child; child = child.nextSibling)
            visit(ariaNode, child, parentElementVisible);
        }
      }
      for (var i = 0; i < ariaChildren.length; i++) visit(ariaNode, ariaChildren[i], parentElementVisible);
      ariaNode.children.push(getCSSContent(element, '::after') || '');
      if (treatAsBlock) ariaNode.children.push(treatAsBlock);

      // Remove redundant child when it equals the node name
      if (ariaNode.children.length === 1 && ariaNode.name === ariaNode.children[0])
        ariaNode.children = [];
    }

    function toAriaNode(element) {
      var role = getAriaRole(element);
      if (!role || role === 'presentation' || role === 'none') return null;

      var name = normalizeWhiteSpace(getElementAccessibleName(element, false));
      var result = { role: role, name: name, children: [] };

      if (kAriaCheckedRoles.indexOf(role) >= 0) {
        var checked = getAriaChecked(element);
        if (checked === true) result.checked = true;
        else if (checked === 'mixed') result.checked = 'mixed';
      }
      if (kAriaDisabledRoles.indexOf(role) >= 0 && getAriaDisabled(element))
        result.disabled = true;
      if (kAriaExpandedRoles.indexOf(role) >= 0) {
        var expanded = getAriaExpanded(element);
        if (expanded !== undefined) result.expanded = expanded;
      }
      if (kAriaLevelRoles.indexOf(role) >= 0) {
        var level = getAriaLevel(element);
        if (level) result.level = level;
      }
      if (kAriaPressedRoles.indexOf(role) >= 0) {
        var pressed = getAriaPressed(element);
        if (pressed === true) result.pressed = true;
        else if (pressed === 'mixed') result.pressed = 'mixed';
      }
      if (kAriaSelectedRoles.indexOf(role) >= 0 && getAriaSelected(element))
        result.selected = true;

      // Value for form controls
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        if (['checkbox','radio','file'].indexOf(element.type) < 0)
          result.value = element.value;
      }

      return result;
    }

    visit(root, rootElement, true);
    normalizeStringChildren(root);
    return root;
  }

  function normalizeStringChildren(ariaNode) {
    var normalizedChildren = [];
    var buffer = [];
    for (var i = 0; i < (ariaNode.children || []).length; i++) {
      var child = ariaNode.children[i];
      if (typeof child === 'string') {
        buffer.push(child);
      } else {
        if (buffer.length) {
          var text = normalizeWhiteSpace(buffer.join(''));
          if (text) normalizedChildren.push(text);
          buffer = [];
        }
        normalizeStringChildren(child);
        normalizedChildren.push(child);
      }
    }
    if (buffer.length) {
      var text = normalizeWhiteSpace(buffer.join(''));
      if (text) normalizedChildren.push(text);
    }
    ariaNode.children = normalizedChildren.length ? normalizedChildren : [];
    if (ariaNode.children.length === 1 && ariaNode.children[0] === ariaNode.name)
      ariaNode.children = [];
  }

  // ===== Convert to AccessibilityNode format =====

  function toAccessibilityNode(ariaNode) {
    var result = { role: ariaNode.role, name: ariaNode.name || '' };
    if (ariaNode.value) result.value = String(ariaNode.value);
    var descParts = [];
    if (ariaNode.checked === true) descParts.push('checked');
    else if (ariaNode.checked === 'mixed') descParts.push('checked=mixed');
    if (ariaNode.disabled) descParts.push('disabled');
    if (ariaNode.expanded === true) descParts.push('expanded');
    else if (ariaNode.expanded === false) descParts.push('collapsed');
    if (ariaNode.level) descParts.push('level=' + ariaNode.level);
    if (ariaNode.pressed === true) descParts.push('pressed');
    else if (ariaNode.pressed === 'mixed') descParts.push('pressed=mixed');
    if (ariaNode.selected) descParts.push('selected');
    if (descParts.length) result.description = descParts.join(', ');

    if (ariaNode.children && ariaNode.children.length) {
      result.children = [];
      for (var i = 0; i < ariaNode.children.length; i++) {
        var child = ariaNode.children[i];
        if (typeof child === 'string') {
          result.children.push({ role: 'text', name: child });
        } else {
          result.children.push(toAccessibilityNode(child));
        }
      }
    }
    return result;
  }

  // ===== Main =====
  try {
    var root = generateAriaTree(document.body || document.documentElement);
    return toAccessibilityNode(root);
  } catch(e) {
    return { role: 'RootWebArea', name: '', description: 'Error: ' + (e.message || String(e)) };
  }
})()`;
