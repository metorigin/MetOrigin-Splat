import { forwardRef } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";
import {
  RotateCw as ArrowClockwiseIcon,
  RotateCcw as ArrowCounterClockwiseIcon,
  ArrowDown as ArrowDownIcon,
  ArrowLeft as ArrowLeftIcon,
  ArrowRight as ArrowRightIcon,
  ArrowUp as ArrowUpIcon,
  Maximize as ArrowsOutIcon,
  ChevronDown as CaretDownIcon,
  ChevronUp as CaretUpIcon,
  Check as CheckIcon,
  CircleCheck as CheckCircleIcon,
  Circle as CircleIcon,
  History as ClockCounterClockwiseIcon,
  Cpu as CpuIcon,
  Box as CubeIcon,
  Database as DatabaseIcon,
  EllipsisVertical as DotsThreeVerticalIcon,
  Download as DownloadSimpleIcon,
  FolderOutput as ExportIcon,
  Eye as EyeIcon,
  Film as FilmStripIcon,
  FolderOpen as FolderOpenIcon,
  Gauge as GaugeIcon,
  Settings as GearSixIcon,
  Grid2X2 as GridFourIcon,
  HardDrive as HardDrivesIcon,
  House as HouseIcon,
  Image as ImageSquareIcon,
  Images as ImagesIcon,
  Info as InfoIcon,
  Link as LinkSimpleIcon,
  Menu as ListIcon,
  List as ListBulletsIcon,
  Search as MagnifyingGlassIcon,
  Monitor as MonitorIcon,
  Route as PathIcon,
  Pause as PauseIcon,
  CirclePause as PauseCircleIcon,
  Play as PlayIcon,
  Pencil as PencilIcon,
  Save as SaveIcon,
  Plus as PlusIcon,
  CircleHelp as QuestionIcon,
  PanelLeft as SidebarSimpleIcon,
  SlidersHorizontal as SlidersHorizontalIcon,
  LoaderCircle as SpinnerGapIcon,
  LayoutGrid as SquaresFourIcon,
  Layers as StackIcon,
  CircleStop as StopCircleIcon,
  Sun as SunIcon,
  Trash as TrashIcon,
  Upload as UploadSimpleIcon,
  TriangleAlert as WarningIcon,
  CircleAlert as WarningCircleIcon,
  X as XIcon,
  CircleX as XCircleIcon
} from "lucide-react";

type IconProps = LucideProps & { weight?: "thin" | "light" | "regular" | "bold" | "fill" | "duotone" };

function adapt(Icon: LucideIcon) {
  return forwardRef<SVGSVGElement, IconProps>(function AppIcon({ weight, ...props }, ref) {
    return <Icon ref={ref} strokeWidth={weight === "bold" ? 2.25 : 1.75} {...props} />;
  });
}

export const ArrowClockwise = adapt(ArrowClockwiseIcon);
export const ArrowCounterClockwise = adapt(ArrowCounterClockwiseIcon);
export const ArrowDown = adapt(ArrowDownIcon);
export const ArrowLeft = adapt(ArrowLeftIcon);
export const ArrowRight = adapt(ArrowRightIcon);
export const ArrowUp = adapt(ArrowUpIcon);
export const ArrowsOut = adapt(ArrowsOutIcon);
export const CaretDown = adapt(CaretDownIcon);
export const CaretUp = adapt(CaretUpIcon);
export const Check = adapt(CheckIcon);
export const CheckCircle = adapt(CheckCircleIcon);
export const Circle = adapt(CircleIcon);
export const ClockCounterClockwise = adapt(ClockCounterClockwiseIcon);
export const Cpu = adapt(CpuIcon);
export const Cube = adapt(CubeIcon);
export const Database = adapt(DatabaseIcon);
export const DotsThreeVertical = adapt(DotsThreeVerticalIcon);
export const DownloadSimple = adapt(DownloadSimpleIcon);
export const Export = adapt(ExportIcon);
export const Eye = adapt(EyeIcon);
export const FilmStrip = adapt(FilmStripIcon);
export const FolderOpen = adapt(FolderOpenIcon);
export const Gauge = adapt(GaugeIcon);
export const GearSix = adapt(GearSixIcon);
export const GridFour = adapt(GridFourIcon);
export const HardDrives = adapt(HardDrivesIcon);
export const House = adapt(HouseIcon);
export const ImageSquare = adapt(ImageSquareIcon);
export const Images = adapt(ImagesIcon);
export const Info = adapt(InfoIcon);
export const LinkSimple = adapt(LinkSimpleIcon);
export const List = adapt(ListIcon);
export const ListBullets = adapt(ListBulletsIcon);
export const MagnifyingGlass = adapt(MagnifyingGlassIcon);
export const Monitor = adapt(MonitorIcon);
export const Path = adapt(PathIcon);
export const Pause = adapt(PauseIcon);
export const PauseCircle = adapt(PauseCircleIcon);
export const Play = adapt(PlayIcon);
export const Pencil = adapt(PencilIcon);
export const Save = adapt(SaveIcon);
export const Plus = adapt(PlusIcon);
export const Question = adapt(QuestionIcon);
export const SidebarSimple = adapt(SidebarSimpleIcon);
export const SlidersHorizontal = adapt(SlidersHorizontalIcon);
export const SpinnerGap = adapt(SpinnerGapIcon);
export const SquaresFour = adapt(SquaresFourIcon);
export const Stack = adapt(StackIcon);
export const StopCircle = adapt(StopCircleIcon);
export const Sun = adapt(SunIcon);
export const Trash = adapt(TrashIcon);
export const UploadSimple = adapt(UploadSimpleIcon);
export const Warning = adapt(WarningIcon);
export const WarningCircle = adapt(WarningCircleIcon);
export const X = adapt(XIcon);
export const XCircle = adapt(XCircleIcon);
