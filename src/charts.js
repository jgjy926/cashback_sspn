import { database } from './state.js';

let catPieChartObj = null;
let sspnTrendChartObj = null, sspnChannelPieChartObj = null;
        function renderCharts(records) {
            const metric = document.getElementById("chartMetricSelector")?.value || "tag";
            const chartData = {};

            records.forEach(t => {
                let key = "Other";
                if (metric === "tag") {
                    key = t.internalTag || "Unassigned";
                } else if (metric === "category") {
                    key = t.category || "Unassigned";
                } else if (metric === "card") {
                    const card = database.cards.find(c => c.id === t.cardId);
                    key = card ? card.name : t.cardId;
                } else if (metric === "bank") {
                    const card = database.cards.find(c => c.id === t.cardId);
                    key = card ? (card.bank || "Unknown Bank") : "Unknown Bank";
                } else if (metric === "month") {
                    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
                    const m = new Date(t.date).getMonth();
                    key = monthNames[m] || "Unknown Month";
                } else if (metric === "year") {
                    key = t.date.substring(0, 4) || "Unknown Year";
                } else if (metric === "status") {
                    key = t.statusMessage || "Unprocessed";
                } else if (metric === "amount") {
                    const val = t.amount;
                    if (val < 50) key = "< RM50";
                    else if (val <= 100) key = "RM50 - RM100";
                    else if (val <= 500) key = "RM100 - RM500";
                    else key = "> RM500";
                } else if (metric === "dayOfWeek") {
                    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
                    const dayIndex = new Date(t.date).getDay();
                    key = days[dayIndex] || "Unknown Day";
                } else if (metric === "description") {
                    key = t.description || "General Expense";
                }
                chartData[key] = (chartData[key] || 0) + t.calculatedCashback;
            });

            if(catPieChartObj) catPieChartObj.destroy();

            const ctx3 = document.getElementById('categoryPieChart');
            if(ctx3) {
                const labels = Object.keys(chartData);
                const values = Object.values(chartData);

                catPieChartObj = new Chart(ctx3, {
                    type: 'doughnut',
                    data: {
                        labels: labels.length > 0 ? labels : ["No Data Available"],
                        datasets: [{ 
                            data: values.length > 0 ? values : [1], 
                            backgroundColor: ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#3b82f6', '#14b8a6', '#f43f5e', '#4b5563'],
                            borderWidth: 2,
                            borderColor: '#111827'
                        }]
                    },
                    options: { 
                        responsive: true, 
                        maintainAspectRatio: false, 
                        plugins: { 
                            legend: { 
                                position: 'bottom',
                                labels: {
                                    color: '#9ca3af',
                                    font: { size: 10, weight: 'bold' },
                                    boxWidth: 12
                                }
                            } 
                        },
                        cutout: '70%'
                    }
                });
            }
        }

        function renderSspnCharts(records) {
            const methodTracker = {};
            const sorted = [...records].sort((a,b) => new Date(a.date) - new Date(b.date));

            let rollingBalance = 0;
            const points = [];
            const labels = [];

            sorted.forEach(r => {
                rollingBalance += r.amount;
                labels.push(r.date);
                points.push(rollingBalance);

                if (r.amount > 0) {
                    methodTracker[r.method] = (methodTracker[r.method] || 0) + r.amount;
                }
            });

            if(sspnTrendChartObj) sspnTrendChartObj.destroy();
            if(sspnChannelPieChartObj) sspnChannelPieChartObj.destroy();

            const sCtx1 = document.getElementById('sspnSavingsTrendChart');
            if(sCtx1) {
                sspnTrendChartObj = new Chart(sCtx1, {
                    type: 'line',
                    data: {
                        labels: labels,
                        datasets: [{
                            label: 'Consolidated Balance (RM)',
                            data: points,
                            borderColor: '#10b981',
                            backgroundColor: 'rgba(16, 185, 129, 0.05)',
                            fill: true,
                            tension: 0.1
                        }]
                    },
                    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
                });
            }

            const sCtx2 = document.getElementById('sspnChannelPieChart');
            if(sCtx2) {
                sspnChannelPieChartObj = new Chart(sCtx2, {
                    type: 'doughnut',
                    data: {
                        labels: Object.keys(methodTracker),
                        datasets: [{ data: Object.values(methodTracker), backgroundColor: ['#10b981', '#3b82f6', '#f59e0b', '#ec4899'] }]
                    },
                    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
                });
            }
        }

export { renderCharts, renderSspnCharts };
