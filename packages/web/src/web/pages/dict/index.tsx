import ClientsDict from "./clients";
import ContainerTypesDict from "./container-types";
import OperationTypesDict from "./operation-types";
import PointsDict from "./points";
import RequestTypesDict from "./request-types";
import { DICT_TABS, DictTabs, type DictTab } from "./shared";

const SECTIONS: Record<DictTab, () => React.ReactNode> = {
  clients: ClientsDict,
  points: PointsDict,
  "request-types": RequestTypesDict,
  operations: OperationTypesDict,
  containers: ContainerTypesDict,
};

export default function DictPage({ section }: { section?: string }) {
  const active = (DICT_TABS.some((t) => t.key === section) ? section : "clients") as DictTab;
  const Section = SECTIONS[active];
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <h1 className="text-xl font-extrabold tracking-tight">Справочники</h1>
      <DictTabs active={active} />
      <Section />
    </div>
  );
}
