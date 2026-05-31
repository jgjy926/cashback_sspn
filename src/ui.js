import { setFilterDeckCollapsed } from './state.js';

        function getThemeStyles(theme) {
            switch(theme) {
                case 'purple': return { bg: 'grad-purple-glow', badge: 'bg-purple-500/10 text-purple-400 border-purple-500/20' };
                case 'emerald': return { bg: 'grad-emerald', badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' };
                case 'indigo': return { bg: 'grad-indigo', badge: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' };
                case 'obsidian': return { bg: 'grad-obsidian', badge: 'bg-slate-500/10 text-slate-400 border-slate-500/20' };
                case 'crimson': return { bg: 'grad-crimson', badge: 'bg-rose-500/10 text-rose-400 border-rose-500/20' };
                case 'amber': return { bg: 'grad-amber', badge: 'bg-amber-500/10 text-amber-400 border-amber-550/20' };
                case 'teal': return { bg: 'grad-teal', badge: 'bg-teal-500/10 text-teal-400 border-teal-500/20' };
                case 'electric': return { bg: 'grad-electric', badge: 'bg-blue-500/10 text-blue-400 border-blue-500/20' };
                case 'rose': return { bg: 'grad-rose', badge: 'bg-pink-500/10 text-pink-400 border-pink-500/20' };
                case 'bronze': return { bg: 'grad-bronze', badge: 'bg-orange-500/10 text-orange-400 border-orange-500/20' };
                default: return { bg: 'grad-obsidian', badge: 'bg-slate-500/10 text-slate-400 border-slate-500/20' };
            }
        }

        function getNetworkIcon(network) {
            const cleanNet = (network || "").toLowerCase();
            if (cleanNet.includes("visa")) return '<i class="fa-brands fa-cc-visa text-indigo-400"></i>';
            if (cleanNet.includes("mastercard")) return '<i class="fa-brands fa-cc-mastercard text-rose-400"></i>';
            if (cleanNet.includes("amex") || cleanNet.includes("american")) return '<i class="fa-brands fa-cc-amex text-cyan-400"></i>';
            if (cleanNet.includes("jcb")) return '<i class="fa-brands fa-cc-jcb text-blue-400"></i>';
            return '<i class="fa-solid fa-credit-card text-slate-400"></i>';
        }

        function toggleMobileMenu() {
            const menu = document.getElementById("navigationWrapper");
            const icon = document.getElementById("mobileMenuIcon");
            if (menu.classList.contains("hidden")) {
                menu.classList.remove("hidden");
                menu.classList.add("flex");
                icon.className = "fa-solid fa-xmark text-lg";
            } else {
                menu.classList.add("hidden");
                menu.classList.remove("flex");
                icon.className = "fa-solid fa-bars text-lg";
            }
        }

        function toggleFilterDeck() {
            const panel = document.getElementById("collapsibleFilterDeck");
            const icon = document.getElementById("filterDeckToggleIcon");
            if (panel.classList.contains("hidden")) {
                panel.classList.remove("hidden");
                icon.className = "fa-solid fa-chevron-up text-slate-400 text-xs";
                setFilterDeckCollapsed(false);
            } else {
                panel.classList.add("hidden");
                icon.className = "fa-solid fa-chevron-down text-slate-400 text-xs";
                setFilterDeckCollapsed(true);
            }
        }

        function askConfirm(msg, proceedCallback) {
            const modal = document.getElementById("customConfirmModal");
            document.getElementById("confirmModalText").innerText = msg;
            modal.classList.remove("hidden");

            const cleanUp = () => {
                modal.classList.add("hidden");
                document.getElementById("confirmProceedBtn").onclick = null;
                document.getElementById("confirmCancelBtn").onclick = null;
            };

            document.getElementById("confirmProceedBtn").onclick = () => { proceedCallback(); cleanUp(); };
            document.getElementById("confirmCancelBtn").onclick = () => { cleanUp(); };
        }

        function showToast(msg, type = "info") {
            const container = document.getElementById("toastContainer");
            const toast = document.createElement("div");
            toast.className = `px-4 py-3 rounded-xl text-xs font-semibold shadow-xl border backdrop-blur-md transition-all duration-300 transform translate-y-2 opacity-0 ${
                type === 'error' ? 'bg-rose-950/90 text-rose-300 border-rose-800' : 'bg-slate-900/90 text-indigo-300 border-indigo-900'
            }`;
            toast.innerText = msg;
            container.appendChild(toast);
            setTimeout(() => { toast.classList.remove('translate-y-2', 'opacity-0'); }, 10);
            setTimeout(() => {
                toast.classList.add('opacity-0', 'translate-y-[-10px]');
                setTimeout(() => { toast.remove(); }, 300);
            }, 3500);
        }

        function switchTab(tabId) {
            document.querySelectorAll("main > section").forEach(s => s.classList.add("hidden"));
            const targetSec = document.getElementById(`tabContent-${tabId}`);
            if(targetSec) targetSec.classList.remove("hidden");

            document.querySelectorAll("nav button").forEach(btn => {
                btn.className = "px-3.5 py-1.5 rounded-lg text-xs font-semibold tracking-wider transition-all duration-200 text-slate-400 hover:text-slate-100 text-left sm:text-center";
            });
            const activeBtn = document.getElementById(`tabBtn-${tabId}`);
            if(activeBtn) {
                if(tabId === 'cashbackOptimizer') {
                    activeBtn.className = "px-3.5 py-1.5 rounded-lg text-xs font-bold tracking-wider transition-all duration-200 bg-indigo-600 text-white shadow-md text-left sm:text-center border border-indigo-500/20";
                } else {
                    activeBtn.className = "px-3.5 py-1.5 rounded-lg text-xs font-semibold tracking-wider transition-all duration-200 bg-indigo-600 text-white shadow-md text-left sm:text-center";
                }
            }
            
            const menu = document.getElementById("navigationWrapper");
            if (window.innerWidth < 1024) {
                menu.classList.add("hidden");
                menu.classList.remove("flex");
                document.getElementById("mobileMenuIcon").className = "fa-solid fa-bars text-lg";
            }
        }

        function initDatePickers() {
            const today = new Date().toISOString().split('T')[0];
            if(document.getElementById("txDate")) document.getElementById("txDate").value = today;
            if(document.getElementById("sspnDate")) document.getElementById("sspnDate").value = today;
        }

export { getThemeStyles, getNetworkIcon, toggleMobileMenu, toggleFilterDeck, askConfirm, showToast, switchTab, initDatePickers };
