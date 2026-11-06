// Mac-style glass dropdowns.
//
// A native <select> popup is drawn by the OS and cannot be styled, so each
// select is paired with a real button + listbox that we draw ourselves. The
// native select stays in the DOM — hidden, but the source of truth — so every
// existing read/write and `change` listener in app.js keeps working.
//
// The listbox is a manual popover: that puts it in the top layer, above an
// open <dialog>, where a plain fixed-position element could never paint. In
// browsers without the Popover API it falls back to a body-appended fixed
// panel (still correct outside dialogs).

const OPEN_CLASS = "is-open";

function labelOf(select) {
  const option = select.selectedOptions?.[0] ?? [...select.options].find((item) => item.selected);
  return option ? option.textContent.trim() : "";
}

function isDisabled(select) {
  return select.disabled || select.getAttribute("aria-disabled") === "true";
}

function place(popover, button) {
  const gap = 8;
  const rect = button.getBoundingClientRect();
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const width = Math.min(Math.max(rect.width, 188), vw - 24);
  popover.style.width = `${width}px`;
  const height = popover.offsetHeight || 260;
  const below = vh - rect.bottom;
  const openUp = below < height + gap && rect.top > below;
  const viewportTop = openUp
    ? Math.max(10, rect.top - gap - height)
    : Math.min(vh - height - 10, rect.bottom + gap);
  const viewportLeft = Math.min(Math.max(10, rect.left), vw - 12 - width);

  // Inside a modal <dialog>, a body-appended popover is inert. The menu lives
  // inside the dialog instead, so its fixed coordinates are measured from the
  // dialog's padding box (its backdrop-filter makes it the containing block).
  const host = popover.parentElement;
  if (host instanceof HTMLDialogElement) {
    const hostRect = host.getBoundingClientRect();
    const style = getComputedStyle(host);
    const originLeft = hostRect.left + parseFloat(style.borderLeftWidth || "0");
    const originTop = hostRect.top + parseFloat(style.borderTopWidth || "0");
    popover.style.left = `${viewportLeft - originLeft}px`;
    popover.style.top = `${viewportTop - originTop}px`;
  } else {
    popover.style.left = `${viewportLeft}px`;
    popover.style.top = `${viewportTop}px`;
  }
  popover.dataset.placement = openUp ? "top" : "bottom";
  popover.style.setProperty(
    "--gpop-caret",
    `${Math.min(Math.max(18, rect.left + rect.width / 2 - viewportLeft), width - 18)}px`,
  );
}

function enhance(select) {
  if (!select || select.dataset.glassSelect === "1") return;
  select.dataset.glassSelect = "1";
  select.classList.add("gselect-native");
  select.setAttribute("tabindex", "-1");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "gselect";
  button.setAttribute("role", "combobox");
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML =
    '<span class="gselect-label"></span>' +
    '<svg class="gselect-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">' +
    '<path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const labelNode = button.querySelector(".gselect-label");
  const fieldLabel = [...(select.labels ?? [])].map((label) => label.textContent.trim()).filter(Boolean).join(" ");
  if (fieldLabel) button.setAttribute("aria-label", fieldLabel);

  // A modal dialog makes everything outside itself inert, so a menu owned by a
  // select inside the dialog has to be a descendant of that dialog. Only the
  // page-level menus can use the top layer.
  const dialog = select.closest("dialog");
  const popover = document.createElement("div");
  popover.className = "gpop";
  popover.setAttribute("role", "listbox");
  popover.id = `${select.id || `gselect-${Math.random().toString(36).slice(2, 8)}`}-listbox`;
  button.setAttribute("aria-controls", popover.id);
  const canPopover = !dialog && typeof popover.showPopover === "function";
  if (canPopover) popover.setAttribute("popover", "manual");
  else popover.hidden = true;
  (dialog ?? document.body).append(popover);

  let active = -1;
  let open = false;

  function refreshLabel() {
    const label = labelOf(select);
    labelNode.textContent = label || " ";
    button.classList.toggle("is-placeholder", !label);
    button.disabled = isDisabled(select);
    button.setAttribute("aria-disabled", isDisabled(select) ? "true" : "false");
    if (open) build();
  }

  function build() {
    popover.textContent = "";
    const options = [...select.options];
    for (let index = 0; index < options.length; index++) {
      const option = options[index];
      const row = document.createElement("div");
      row.className = "gopt";
      row.setAttribute("role", "option");
      row.id = `${popover.id}-${index}`;
      row.dataset.index = String(index);
      row.setAttribute("aria-selected", option.selected ? "true" : "false");
      if (option.disabled) row.classList.add("is-disabled");
      if (option.selected) row.classList.add("is-selected");

      const text = document.createElement("span");
      text.className = "gopt-label";
      text.textContent = option.textContent.trim();
      const check = document.createElement("span");
      check.className = "gopt-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = "✓";
      row.append(text, check);

      row.addEventListener("mouseenter", () => setActive(index));
      row.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (option.disabled) return;
        choose(index);
      });
      popover.append(row);
    }
    const selected = options.findIndex((option) => option.selected);
    setActive(selected >= 0 ? selected : 0);
  }

  function setActive(index) {
    const rows = [...popover.querySelectorAll(".gopt")];
    if (!rows.length) return;
    active = Math.max(0, Math.min(rows.length - 1, index));
    rows.forEach((row, i) => row.classList.toggle("is-active", i === active));
    const row = rows[active];
    // aria-activedescendant belongs on the combobox, which keeps focus.
    button.setAttribute("aria-activedescendant", row.id);
    if (row) {
      const top = row.offsetTop;
      const bottom = top + row.offsetHeight;
      if (top < popover.scrollTop) popover.scrollTop = top;
      else if (bottom > popover.scrollTop + popover.clientHeight) {
        popover.scrollTop = bottom - popover.clientHeight;
      }
    }
  }

  function choose(index) {
    const option = select.options[index];
    if (!option || option.disabled) return;
    if (select.value !== option.value) {
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    refreshLabel();
    close();
    button.focus();
  }

  function layout() {
    if (open) place(popover, button);
  }

  function show() {
    if (open || isDisabled(select)) return;
    refreshLabel();
    build();
    open = true;
    if (canPopover) {
      if (!popover.matches(":popover-open")) popover.showPopover();
    } else {
      popover.hidden = false;
    }
    button.setAttribute("aria-expanded", "true");
    button.classList.add(OPEN_CLASS);
    layout();
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("scroll", layout, true);
    window.addEventListener("resize", layout);
  }

  function close() {
    if (!open) return;
    open = false;
    if (canPopover) {
      if (popover.matches(":popover-open")) popover.hidePopover();
    } else {
      popover.hidden = true;
    }
    button.setAttribute("aria-expanded", "false");
    button.classList.remove(OPEN_CLASS);
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("scroll", layout, true);
    window.removeEventListener("resize", layout);
  }

  function onOutside(event) {
    if (popover.contains(event.target) || button.contains(event.target)) return;
    close();
  }

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (open) close();
    else show();
  });

  button.addEventListener("keydown", (event) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      if (!open) {
        show();
        return;
      }
    }
    if (!open) return;
    if (event.key === "ArrowDown") setActive(active + 1);
    else if (event.key === "ArrowUp") setActive(active - 1);
    else if (event.key === "Home") setActive(0);
    else if (event.key === "End") setActive(select.options.length - 1);
    else if (event.key === "Enter") choose(active);
    else if (event.key === "Escape") {
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") close();
  });

  // Escape while the pointer is inside the listbox (it never takes focus).
  popover.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  select.addEventListener("change", refreshLabel);
  select.addEventListener("focus", () => button.focus());

  // app.js assigns `select.value` directly, which fires no event and changes
  // no attribute — observe the property so the visible label never goes stale.
  const proto = window.HTMLSelectElement.prototype;
  const valueDescriptor = Object.getOwnPropertyDescriptor(proto, "value");
  Object.defineProperty(select, "value", {
    configurable: true,
    get() {
      return valueDescriptor.get.call(this);
    },
    set(next) {
      valueDescriptor.set.call(this, next);
      refreshLabel();
    },
  });

  const observer = new MutationObserver(refreshLabel);
  observer.observe(select, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled"],
  });

  // The button takes the select's place in the field; the select stays for
  // value semantics and screen readers.
  select.insertAdjacentElement("afterend", button);
  refreshLabel();
}

function enhanceAll(root = document) {
  for (const select of root.querySelectorAll("select")) {
    if (select.multiple) continue;
    enhance(select);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => enhanceAll(), { once: true });
} else {
  enhanceAll();
}
