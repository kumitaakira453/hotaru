import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Popover from "./Popover";

// 同じ画面を 2 つの窓で使い分ける。メニューバーから開く方は要約だけを見せる。
const isPopover = window.location.hash === "#popover" || document.title === "hotaru-popover";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isPopover ? <Popover /> : <App />}</React.StrictMode>,
);
