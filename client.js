// dsh-memory — Client bundle: the Memory page inside Settings.
//
// One page, four parts: which model does the remembering, what it costs per turn,
// which scopes are enrolled (folded by default), and a chat channel to it.
//
// The chat is deliberately stateless on the server: the message list lives in this
// component's state and nothing about the conversation is written to disk. Closing
// the panel throws the whole conversation away. The one thing that survives is a
// memory that was changed *with a reason* — that reason is stored on the record
// itself by the host, because otherwise the change has no provenance.
//
// The reason gate is enforced twice: the memory model is told to ask for one, and
// the host drops any change proposal that arrives without one. This page therefore
// treats `blocked` as "it wants a reason", not as an error.
window.__ModuleLoader__.load({
	id: "dsh-memory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");
		var h = React.createElement;

		var API = "/dsh-memory";
		var DIM = "var(--dsw-alias-label-tertiary, #8a8a92)";
		var SOFT = "var(--dsw-alias-label-secondary, #9a9aa2)";
		var BORDER = "var(--dsw-alias-border-l3, rgba(127,127,127,0.35))";
		var SURFACE = "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))";
		var ACCENT = "var(--dsw-alias-state-business-primary, #4a7dff)";

		function request(path, options) {
			var init = Object.assign({ credentials: "same-origin" }, options || {});
			init.headers = Object.assign({ "content-type": "application/json" }, init.headers || {});
			return fetch(API + path, init).then(function (response) {
				return response.json().then(function (body) {
					return { ok: response.ok, status: response.status, body: body };
				}).catch(function () {
					return { ok: false, status: response.status, body: {} };
				});
			});
		}

		function post(path, payload) {
			return request(path, { method: "POST", body: JSON.stringify(payload || {}) });
		}

		/** A brain, drawn once: the page icon and the settings row's mark. */
		function Brain(props) {
			var size = props && props.size ? props.size : 22;
			return h("svg", {
				viewBox: "0 0 64 64", width: size, height: size, "aria-hidden": true,
				style: { display: "block", flex: "none" }
			},
				h("path", {
					d: "M28 12c-7 0-11 4-11 10 0 2-3 3-3 7s2 4 2 7-2 3-2 6c0 6 5 10 12 10 3 0 4-1 4-4V16c0-3-1-4-2-4z",
					fill: "none", stroke: "#8FE3C2", strokeWidth: 3, strokeLinejoin: "round"
				}),
				h("path", {
					d: "M36 12c7 0 11 4 11 10 0 2 3 3 3 7s-2 4-2 7 2 3 2 6c0 6-5 10-12 10-3 0-4-1-4-4V16c0-3 1-4 2-4z",
					fill: "none", stroke: "#3FB98A", strokeWidth: 3, strokeLinejoin: "round"
				}),
				h("path", { d: "M20 26h6M20 38h6M38 22h6M38 34h6M38 46h5", stroke: "#5A6274", strokeWidth: 2.5, strokeLinecap: "round" })
			);
		}

		/**
		 * The composer switch: is THIS session wired into the shared memory?
		 *
		 * Off means the session is not handed remembered facts, is not asked to
		 * report, and is not catalogued — nothing is deleted, and it can still be
		 * turned back on. The slot hands us `sessionId`, so the choice is per
		 * conversation rather than per deployment.
		 */
		function MemoryChip(props) {
			var sessionId = props && props.sessionId ? String(props.sessionId) : "";
			var offState = React.useState(null);
			var off = offState[0];
			var setOff = offState[1];
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			// A failed toggle used to revert silently, which reads as "the switch is
			// broken". Say it instead: the commonest cause is a stale host half.
			var errState = React.useState("");
			var err = errState[0];
			var setErr = errState[1];

			React.useEffect(function () {
				if (sessionId.length === 0) return undefined;
				var alive = true;
				request("/panel?session=" + encodeURIComponent(sessionId)).then(function (result) {
					if (!alive || !result.ok) return;
					setOff(result.body.disabled === true);
				}).catch(function () { /* leave it hidden rather than guess */ });
				return function () { alive = false; };
			}, [sessionId]);

			// Undefined session (no conversation yet) or still loading: draw nothing.
			if (sessionId.length === 0 || off === null) return null;

			function toggle() {
				if (busy) return;
				var next = !off;
				setOff(next);
				setBusy(true);
				setErr("");
				post("/toggle", { session: sessionId, off: next }).then(function (result) {
					if (!result.ok) {
						setOff(off);
						setErr(result.status === 404
							? "宿主还没加载 /dsh-memory/toggle——需要重启一次 harness"
							: "切换失败：" + (result.body.error || result.status));
						return;
					}
					setOff(result.body.disabled === true);
				}).catch(function (error) {
					setOff(off);
					setErr("切换失败：" + String((error && error.message) || error));
				}).then(function () {
					setBusy(false);
				});
			}

			var on = !off;
			var broken = err.length > 0;
			return h("button", {
				type: "button",
				onClick: toggle,
				"aria-pressed": on,
				title: broken
					? err
					: on
						? "本会话由统一记忆保管：会带上相关记忆，也按流程写入。点一下断开（已有记忆不会删）。"
						: "本会话不接入统一记忆：不注入、不要求写入、不进目录。已有记忆不会被删除。点一下接入。",
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: 5,
					height: 22,
					padding: "0 8px",
					borderRadius: 11,
					border: "1px solid " + (broken ? "rgba(244,121,107,0.75)" : on ? "rgba(63,185,138,0.55)" : BORDER),
					background: broken ? "rgba(244,121,107,0.16)" : on ? "rgba(63,185,138,0.16)" : "transparent",
					color: on ? "inherit" : DIM,
					fontSize: 11,
					lineHeight: "20px",
					cursor: busy ? "default" : "pointer",
					opacity: busy ? 0.6 : 1,
					flex: "none",
					whiteSpace: "nowrap"
				}
			},
				h("span", {
					style: {
						display: "block",
						width: 7,
						height: 7,
						borderRadius: 4,
						background: broken ? "#F4796B" : on ? "#3FB98A" : "transparent",
						border: broken || on ? "none" : "1px solid " + DIM
					}
				}),
				broken ? "记忆 未就绪" : "记忆"
			);
		}

		function Section(props) {
			return h("div", { style: { marginBottom: 22 } },
				h("div", { style: { fontSize: 13, fontWeight: 600, marginBottom: 8, letterSpacing: 0.2 } }, props.title),
				props.children);
		}

		function Muted(props) {
			return h("div", { style: { fontSize: 12, color: DIM, lineHeight: 1.6 } }, props.children);
		}

		var selectStyle = {
			padding: "5px 8px", borderRadius: 7, border: "1px solid " + BORDER,
			background: "transparent", color: "inherit", fontSize: 12, cursor: "pointer"
		};
		var inputStyle = {
			padding: "6px 9px", borderRadius: 7, border: "1px solid " + BORDER,
			background: "transparent", color: "inherit", fontSize: 12, width: "100%", boxSizing: "border-box"
		};
		var buttonStyle = {
			padding: "5px 12px", borderRadius: 7, border: "1px solid " + BORDER,
			background: "transparent", color: "inherit", fontSize: 12, cursor: "pointer"
		};

		function Panel() {
			var panelState = React.useState(null);
			var panel = panelState[0];
			var setPanel = panelState[1];
			var noteState = React.useState("");
			var note = noteState[0];
			var setNote = noteState[1];
			var openState = React.useState(false);
			var scopesOpen = openState[0];
			var setScopesOpen = openState[1];
			var logState = React.useState([]);
			var chat = logState[0];
			var setChat = logState[1];
			var draftState = React.useState("");
			var draft = draftState[0];
			var setDraft = draftState[1];
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var askState = React.useState(null);
			var askingReason = askState[0];
			var setAskingReason = askState[1];
			var reasonState = React.useState("");
			// The key is never rendered back: the field starts empty and only ever
			// holds what the person just typed.
			var keyDraftState = React.useState("");
			var keyDraft = keyDraftState[0];
			var setKeyDraft = keyDraftState[1];
			var reason = reasonState[0];
			var setReason = reasonState[1];

			function load() {
				return request("/panel").then(function (result) {
					if (result.ok) setPanel(result.body);
					else setNote("读取失败：" + result.status);
				}).catch(function (error) {
					setNote("读取失败：" + String((error && error.message) || error));
				});
			}

			React.useEffect(function () { load(); }, []);

			function push(entry) {
				setChat(function (previous) {
					return previous.concat([entry]).slice(-40);
				});
			}

			function save(patch) {
				setNote("保存中…");
				return post("/config", patch).then(function (result) {
					if (!result.ok) { setNote("保存失败：" + (result.body.error || result.status)); return; }
					setPanel(function (previous) {
						return previous === null ? previous : Object.assign({}, previous, { config: result.body.config });
					});
					setNote("已保存");
				}).catch(function (error) {
					setNote("保存失败：" + String((error && error.message) || error));
				});
			}

			function saveKey() {
				var value = String(keyDraft || "").trim();
				if (value.length === 0) { setNote("没有输入新的 key"); return; }
				setNote("保存 key…");
				post("/key", { key: value }).then(function (result) {
					if (!result.ok) { setNote(result.status === 404 ? "宿主还没加载 /dsh-memory/key——需要重启一次 harness" : "保存失败：" + (result.body.error || result.status)); return; }
					setKeyDraft("");
					setPanel(function (previous) {
						return previous === null ? previous : Object.assign({}, previous, {
							keySet: result.body.keySet === true,
							keyFromEnv: result.body.keyFromEnv === true
						});
					});
					setNote(result.body.keySet ? "key 已保存" : "key 未生效");
				}).catch(function (error) {
					setNote("保存失败：" + String((error && error.message) || error));
				});
			}

			function clearKey() {
				setNote("清除 key…");
				post("/key", { key: "" }).then(function (result) {
					if (!result.ok) { setNote(result.status === 404 ? "宿主还没加载 /dsh-memory/key——需要重启一次 harness" : "清除失败：" + (result.body.error || result.status)); return; }
					setKeyDraft("");
					setPanel(function (previous) {
						return previous === null ? previous : Object.assign({}, previous, { keySet: result.body.keySet === true });
					});
					setNote("key 已清除");
				}).catch(function (error) {
					setNote("清除失败：" + String((error && error.message) || error));
				});
			}

			function send(text, reasonText) {
				var message = String(text || "").trim();
				if (message.length === 0 || busy) return;
				if (!reasonText) push({ role: "user", text: message });
				setBusy(true);
				setNote("");
				post("/chat", { message: message, reason: reasonText || "" }).then(function (result) {
					if (!result.ok) {
						push({ role: "memory", text: "（调用失败：" + (result.body.error || result.status) + "）" });
						return;
					}
					push({ role: "memory", text: result.body.reply });
					if (result.body.applied) push({ role: "note", text: result.body.applied });
					if (result.body.refusal) push({ role: "note", text: "宿主拒绝：" + result.body.refusal });
					if (result.body.blocked) {
						setAskingReason(message);
						push({ role: "note", text: "它在动记忆之前要一个理由。" });
					} else {
						setAskingReason(null);
					}
					if (result.body.change === null && result.body.applied === null && !result.body.blocked) {
						// read-only answer: nothing to apply
					}
					load();
				}).catch(function (error) {
					push({ role: "memory", text: "（调用失败：" + String((error && error.message) || error) + "）" });
				}).then(function () {
					setBusy(false);
				});
			}

			if (panel === null) {
				return h("div", { style: { padding: "4px 2px", color: DIM, fontSize: 12 } }, note || "读取中…");
			}

			var config = panel.config || {};
			var stats = panel.stats || {};
			var kinds = stats.byKind || {};
			var kindRows = Object.keys(kinds).map(function (key) {
				var item = kinds[key];
				var label = key === "organise" ? "一级整理"
					: key === "consolidate" ? "二级整理"
					: key === "converse" ? "面板对话"
					: key.indexOf(":error") > 0 ? "失败（" + key.split(":")[0] + "）"
					: key;
				return h("div", { key: key, style: { display: "flex", justifyContent: "space-between", fontSize: 12, color: SOFT, padding: "3px 0" } },
					h("span", null, label),
					h("span", null, item.avgMs + " ms × " + item.calls));
			});

			var scopeRows = (panel.scopes || []).map(function (row) {
				return h("div", { key: row.scope, style: { display: "flex", justifyContent: "space-between", fontSize: 12, color: SOFT, padding: "3px 0", borderTop: "1px solid " + BORDER } },
					h("span", { style: { fontFamily: "ui-monospace, monospace" } }, row.scope),
					h("span", null, row.facts + " 事实 · " + row.entries + " 条"));
			});

			return h("div", { style: { padding: "4px 2px", maxWidth: 720 } },
				h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 6 } },
					h(Brain, { size: 26 }),
					h("div", { style: { fontSize: 15, fontWeight: 600 } }, "记忆"),
					note ? h("div", { style: { marginLeft: "auto", fontSize: 12, color: DIM } }, note) : null),
				h(Muted, null,
					"记忆分四层：性格、二级、一级、本次对话。每轮结束主模型先向记忆模型汇报，它整理成一级记忆——",
					"顺序是它先知道，再回答你。"),

				h(Section, { title: "记忆模型" },
					h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" } },
						h("span", { style: { fontSize: 12, color: DIM, minWidth: 64 } }, "模型"),
						h("input", {
							value: config.model || "",
							onChange: function (event) {
								setPanel(Object.assign({}, panel, { config: Object.assign({}, config, { model: event.target.value }) }));
							},
							onBlur: function () { save({ model: config.model }); },
							style: Object.assign({}, inputStyle, { width: 220 })
						}),
						h("span", { style: { fontSize: 11, color: DIM } }, "默认 " + panel.modelDefault)),
					h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8 } },
						h("span", { style: { fontSize: 12, color: DIM, minWidth: 64 } }, "思考"),
						h("select", {
							value: config.thinking || "auto",
							onChange: function (event) { save({ thinking: event.target.value }); },
							style: selectStyle
						},
							h("option", { value: "auto" }, "自动（接口默认）"),
							h("option", { value: "enabled" }, "强制开启"),
							h("option", { value: "disabled" }, "关闭"))),
					h(Muted, null,
						"实测这个接口：reasoning_effort 基本无效，thinking:{type} 看起来能压掉推理，所以只给三态，不给骗人的档位。"),
					h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" } },
						h("span", { style: { fontSize: 12, color: DIM, minWidth: 64 } }, "API key"),
						h("input", {
							type: "password",
							autoComplete: "off",
							value: keyDraft,
							placeholder: panel.keySet ? "已配置，留空不改" : "sk-…",
							onChange: function (event) { setKeyDraft(event.target.value); },
							onKeyDown: function (event) { if (event.key === "Enter") saveKey(); },
							style: Object.assign({}, inputStyle, { width: 260 })
						}),
						h("button", { onClick: saveKey, style: buttonStyle }, "保存"),
						panel.keySet ? h("button", { onClick: clearKey, style: buttonStyle }, "清除") : null),
					h(Muted, null,
						panel.keyFromEnv
							? "环境变量 DSH_MEMORY_API_KEY 已设置，它优先于这里保存的值。"
							: panel.keySet
								? "已配置 · " + panel.keyPath + "（权限 600，只写不读）"
								: "未配置 · 保存后写入 " + panel.keyPath)),

				h(Section, { title: "每轮耗时" },
					h("div", { style: { fontSize: 22, fontWeight: 600, letterSpacing: -0.3 } },
						stats.avgMs ? String(stats.avgMs) : "—",
						h("span", { style: { fontSize: 12, fontWeight: 400, color: DIM, marginLeft: 6 } }, "ms 平均")),
					h(Muted, null,
						"共 " + (stats.calls || 0) + " 次调用 · 最近一次 " + (stats.lastMs || 0) + " ms" + (stats.at ? " · " + stats.at.slice(5, 16).replace("T", " ") : "")),
					kindRows.length > 0 ? h("div", { style: { marginTop: 6 } }, kindRows) : null),

				h(Section, { title: "接入记忆框架的档" },
					h("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
						h("span", { style: { fontSize: 13 } },
							(panel.scopes || []).length + " 个作用域 · " + panel.facts + " 条事实 · " + panel.entries + " 条日志 · " + panel.sessions + " 个会话"),
						h("button", {
							onClick: function () { setScopesOpen(!scopesOpen); },
							style: buttonStyle
						}, scopesOpen ? "收起" : "展开")),
					scopesOpen ? h("div", { style: { marginTop: 8 } }, scopeRows) : null,
					h(Muted, null, "隐藏过 " + (panel.hidden || 0) + " 条（可恢复）")),

				h(Section, { title: "和记忆模型说话" },
					h("div", {
						style: {
							border: "1px solid " + BORDER, borderRadius: 10, background: SURFACE,
							padding: 10, maxHeight: 260, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8
						}
					},
						chat.length === 0
							? h("div", { style: { fontSize: 12, color: DIM } }, "问它记了什么、为什么记；要改记忆时它会给你要一个理由。")
							: chat.map(function (entry, index) {
								var mine = entry.role === "user";
								var isNote = entry.role === "note";
								return h("div", {
									key: index,
									style: {
										fontSize: 12,
										lineHeight: 1.6,
										alignSelf: mine ? "flex-end" : "flex-start",
										maxWidth: "86%",
										padding: "6px 9px",
										borderRadius: 9,
										border: "1px solid " + (isNote ? "transparent" : BORDER),
										background: mine ? "rgba(74,125,255,0.14)" : isNote ? "transparent" : "transparent",
										color: isNote ? DIM : "inherit",
										whiteSpace: "pre-wrap"
									}
								}, entry.text);
							})),

					askingReason === null
						? h("div", { style: { display: "flex", gap: 8, marginTop: 8 } },
							h("input", {
								value: draft,
								placeholder: busy ? "等待记忆模型…" : "问它：「你知道什么」",
								onChange: function (event) { setDraft(event.target.value); },
								onKeyDown: function (event) { if (event.key === "Enter") send(draft, ""); },
								disabled: busy,
								style: inputStyle
							}),
							h("button", { onClick: function () { var text = draft; setDraft(""); send(text, ""); }, disabled: busy, style: buttonStyle }, "发送"))
						: h("div", { style: { marginTop: 8 } },
							h(Muted, null, "要改的是：「" + askingReason + "」。它要一个理由——写下来，改动才会被记进去。"),
							h("div", { style: { display: "flex", gap: 8, marginTop: 6 } },
								h("input", {
									value: reason,
									placeholder: "为什么改？（例如：这条结论已被新实验推翻）",
									onChange: function (event) { setReason(event.target.value); },
									onKeyDown: function (event) {
										if (event.key !== "Enter" || reason.trim().length === 0) return;
										push({ role: "note", text: "修改理由：" + reason });
										setBusy(true);
										post("/chat", { message: askingReason, reason: reason }).then(function (result) {
											if (!result.ok) { push({ role: "memory", text: "（调用失败：" + (result.body.error || result.status) + "）" }); return; }
											push({ role: "memory", text: result.body.reply });
											if (result.body.applied) push({ role: "note", text: result.body.applied });
											if (result.body.refusal) push({ role: "note", text: "宿主拒绝：" + result.body.refusal });
											setAskingReason(null);
											setReason("");
											load();
										}).catch(function (error) {
											push({ role: "memory", text: "（调用失败：" + String((error && error.message) || error) + "）" });
										}).then(function () { setBusy(false); });
									},
									disabled: busy,
									style: inputStyle
								}),
								h("button", {
									disabled: busy || reason.trim().length === 0,
									onClick: function () {
										push({ role: "note", text: "修改理由：" + reason });
										setBusy(true);
										post("/chat", { message: askingReason, reason: reason }).then(function (result) {
											if (!result.ok) { push({ role: "memory", text: "（调用失败：" + (result.body.error || result.status) + "）" }); return; }
											push({ role: "memory", text: result.body.reply });
											if (result.body.applied) push({ role: "note", text: result.body.applied });
											if (result.body.refusal) push({ role: "note", text: "宿主拒绝：" + result.body.refusal });
											setAskingReason(null);
											setReason("");
											load();
										}).catch(function (error) {
											push({ role: "memory", text: "（调用失败：" + String((error && error.message) || error) + "）" });
										}).then(function () { setBusy(false); });
									},
									style: buttonStyle
								}, "提交理由"))),

					h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginTop: 8 } },
						h("button", {
							onClick: function () { setChat([]); setAskingReason(null); setReason(""); setDraft(""); },
							style: buttonStyle
						}, "清空对话"),
						h(Muted, null, "关掉这个页面，这段对话就没了。只有「带理由并被改过」的记忆会留下——理由存在那条记录上。")))
			);
		}

		var inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("conversation.input.left", function () {
				return ctx.slots.register({
					name: "conversation.input.left",
					id: "memory-chip",
					order: 5
				}, MemoryChip);
			});
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: "memory",
					order: 97,
					label: function () { return "记忆"; }
				}, Panel);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
