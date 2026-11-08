import http from "../api";
import type {
  FeesData,
  FinanceData,
  FinancialFilters,
  Obligation,
  Receipt,
} from "../types/financial";

function query(filters: FinancialFilters) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== "") params.set(key, String(value));
  });
  return params.toString();
}
async function call<T>(
  method: "GET" | "POST" | "PATCH",
  url: string,
  data?: unknown,
) {
  try {
    return (await http.request<T>({ method, url, data })).data;
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response
      ?.status;
    if (status === 401) window.dispatchEvent(new Event("session-expired"));
    throw error;
  }
}
export const financialApi = {
  requestStatus: (key: string) =>
    call<{ id: string; action: string } | null>(
      "GET",
      "/financial-requests/" + encodeURIComponent(key),
    ),
  fees: (filters: FinancialFilters) =>
    call<FeesData>("GET", "/fees-due?" + query(filters)),
  invoice: (id: string) =>
    call<{ invoice: Obligation; payments: Receipt[] }>(
      "GET",
      "/fees-due/" + encodeURIComponent(id),
    ),
  finances: (filters: FinancialFilters) =>
    call<FinanceData>("GET", "/finances?" + query(filters)),
  command: (
    url: string,
    data: Record<string, unknown>,
    method: "POST" | "PATCH" = "POST",
  ) => call<{ id: string; action: string }>(method, url, data),
  async export(filters: FinancialFilters) {
    const result = await http.get<Blob>("/finances/export?" + query(filters), {
      responseType: "blob",
    });
    const url = URL.createObjectURL(result.data);
    const link = document.createElement("a");
    link.href = url;
    link.download = "financial-transactions.csv";
    link.click();
    URL.revokeObjectURL(url);
  },
};
