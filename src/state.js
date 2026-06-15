// Shared application state. The database object is a live ES export reassigned
// only through setDatabase(); the four UI flags are reassigned through their setters.
export const SCHEMA_VERSION = 1;

export let database = {
            transactions: [],
            sspnRecords: [],
            claims: [],
            cards: [
                { 
                    id: "Maybank2Gold", 
                    name: "Maybank 2 Gold", 
                    bank: "Maybank",
                    network: "Mastercard",
                    last4: "4321",
                    theme: "purple", 
                    billingDay: 25, 
                    cycleMinSpend: 0,
                    cycleCashbackCap: 50,
                    rules: [
                        { category: "Weekend Dining", standardCategories: ["Dining"], rate: 0.05, minTxSpend: 0, categoryCap: 50, tiered: false, weekendOnly: true, merchants: "McDonald's, Starbucks, Pizza Hut, KFC, Nando's", daysOnly: "", monthsOnly: "", tiers: [] },
                        { category: "Utilities", standardCategories: ["Utilities"], rate: 0.01, minTxSpend: 0, categoryCap: 0, tiered: false, weekendOnly: false, merchants: "TNB, Syabas, Telekom, Maxis", daysOnly: "", monthsOnly: "", tiers: [] },
                        { category: "Other spending", standardCategories: ["Other Spending"], rate: 0.002, minTxSpend: 0, categoryCap: 0, tiered: false, weekendOnly: false, merchants: "", daysOnly: "", monthsOnly: "", tiers: [] }
                    ]
                },
                { 
                    id: "PublicBankQuantum", 
                    name: "Public Bank Quantum", 
                    bank: "Public Bank",
                    network: "Visa",
                    last4: "8765",
                    theme: "emerald", 
                    billingDay: 10, 
                    cycleMinSpend: 0,
                    cycleCashbackCap: 30,
                    rules: [
                        { category: "Online/Contactless", standardCategories: ["Online/Contactless"], rate: 0.02, minTxSpend: 30, categoryCap: 30, tiered: false, weekendOnly: false, merchants: "Shopee, Lazada, Grab, Foodpanda, Touch 'n Go, Taobao", daysOnly: "", monthsOnly: "", tiers: [] },
                        { category: "Other spending", standardCategories: ["Other Spending"], rate: 0.003, minTxSpend: 0, categoryCap: 0, tiered: false, weekendOnly: false, merchants: "", daysOnly: "", monthsOnly: "", tiers: [] }
                    ]
                },
                { 
                    id: "CIMBCashback", 
                    name: "CIMB Cash Back", 
                    bank: "CIMB",
                    network: "Mastercard",
                    last4: "2109",
                    theme: "indigo", 
                    billingDay: 15, 
                    cycleMinSpend: 500,
                    cycleCashbackCap: 60,
                    rules: [
                        { 
                            category: "Groceries", 
                            standardCategories: ["Groceries"],
                            rate: 0.04, 
                            minTxSpend: 100, 
                            categoryCap: 30, 
                            tiered: true, 
                            weekendOnly: false,
                            merchants: "Aeon, Aeon Big, Lotus's, Giant, Jaya Grocer, Village Grocer",
                            daysOnly: "",
                            monthsOnly: "",
                            tiers: [
                                { minSpend: 500, rate: 0.02 },
                                { minSpend: 1000, rate: 0.04 }
                            ] 
                        },
                        { category: "Other spending", standardCategories: ["Other Spending"], rate: 0.002, minTxSpend: 0, categoryCap: 0, tiered: false, weekendOnly: false, merchants: "", daysOnly: "", monthsOnly: "", tiers: [] }
                    ]
                },
                { 
                    id: "AeonMemberPlus", 
                    name: "AEON Member Plus Visa Gold", 
                    bank: "AEON",
                    network: "Visa",
                    last4: "9988",
                    theme: "purple", 
                    billingDay: 20, 
                    cycleMinSpend: 0,
                    cycleCashbackCap: 100,
                    rules: [
                        { 
                            category: "AEON Shopping Days", 
                            standardCategories: ["Groceries"],
                            rate: 0.08, 
                            minTxSpend: 0, 
                            categoryCap: 0, 
                            tiered: false, 
                            weekendOnly: false,
                            merchants: "Aeon, Aeon Big, Aeon MaxValu",
                            daysOnly: "20, 28",
                            monthsOnly: "",
                            tiers: [] 
                        },
                        { category: "Other Spending", standardCategories: ["Other Spending"], rate: 0.005, minTxSpend: 0, categoryCap: 0, tiered: false, weekendOnly: false, merchants: "", daysOnly: "", monthsOnly: "", tiers: [] }
                    ]
                }
            ],
            settings: {
                internalCategories: ["Dining", "Groceries", "Utilities", "Shopping", "Transport", "Investment"],
                sspnChannels: ["PTPTN Portal", "Bank Transfer", "Salary Deduction"],
                sspnDevices: ["Mobile Phone", "Web Browser", "Counter Kiosk"],
                sspnMethods: ["FPX Online", "Credit Card Route", "Direct Debit"],
                optimizerCategories: ["Dining", "Groceries", "Utilities", "Petrol", "Online/Contactless", "Other Spending"],
                claimTypes: ["Medical", "Insurance", "Tax Relief"],
                claimStatuses: ["Not Submitted", "Submitted", "Approved", "Reimbursed", "Rejected"]
            }
        };

export function setDatabase(next) { database = next; }

export let currentFilterCard = "ALL";
export let currentInteractiveCardId = "ALL";
export let sspnSignIsPositive = true;
export let filterDeckCollapsed = true;

export function setCurrentFilterCard(v) { currentFilterCard = v; }
export function setCurrentInteractiveCardId(v) { currentInteractiveCardId = v; }
export function setSspnSignIsPositive(v) { sspnSignIsPositive = v; }
export function setFilterDeckCollapsed(v) { filterDeckCollapsed = v; }
