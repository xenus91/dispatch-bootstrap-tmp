import { Redirect, Route, Switch, useLocation } from "wouter";
import { Provider } from "./components/provider";
import { Shell } from "./components/shell";
import { useMe } from "./queries/auth";
import { useMaxChrome } from "./hooks/use-max-chrome";
import { inMax } from "./lib/miniapp";
import Login from "./pages/login";
import MaxLogin from "./pages/max-login";
import Requests from "./pages/requests";
import RequestDetail from "./pages/request-detail";
import RequestForm from "./pages/request-form";
import Staff from "./pages/staff";
import SessionsPage from "./pages/sessions";
import SettingsPage from "./pages/settings";
import NotificationsPage from "./pages/notifications";
import Privacy from "./pages/privacy";
import AuditPage from "./pages/audit";
import DictPage from "./pages/dict";

function Routes() {
  const me = useMe();
  useMaxChrome();
  const [location] = useLocation();

  // Политика обработки персональных данных открыта без авторизации:
  // субъект должен иметь возможность прочитать условия до того, как даст согласие.
  if (location === "/privacy") return <Privacy />;

  if (me.isLoading) {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-[var(--muted-foreground)]">
        Загрузка…
      </div>
    );
  }

  // Внутри MAX сначала пробуем автовход по initData, в браузере — телефон + код.
  if (!me.data) return inMax() ? <MaxLogin /> : <Login />;

  const user = me.data;
  const isAdmin = user.role === "admin";

  return (
    <Shell me={me.data}>
      <Switch>
        <Route path="/" component={Requests} />
        <Route path="/requests" component={Requests} />
        <Route path="/requests/new">{() => <RequestForm />}</Route>
        <Route path="/requests/:id/edit">{(p) => <RequestForm id={p.id} />}</Route>
        <Route path="/requests/:id">{(p) => <RequestDetail id={p.id} />}</Route>
        <Route path="/staff">{() => (isAdmin ? <Staff /> : <Redirect to="/" />)}</Route>
        <Route path="/audit">{() => (isAdmin ? <AuditPage /> : <Redirect to="/" />)}</Route>
        <Route path="/settings">{() => (isAdmin ? <SettingsPage /> : <Redirect to="/" />)}</Route>
        <Route path="/dict/:section">{(p) => <DictPage section={p.section} />}</Route>
        <Route path="/dict">{() => <Redirect to="/dict/clients" />}</Route>
        <Route path="/sessions" component={SessionsPage} />
        <Route path="/notifications">{() => (user.role !== "driver" ? <NotificationsPage /> : <Redirect to="/" />)}</Route>
        <Route>
          <Redirect to="/" />
        </Route>
      </Switch>
    </Shell>
  );
}

function App() {
  return (
    <Provider>
      <Routes />
    </Provider>
  );
}

export default App;
