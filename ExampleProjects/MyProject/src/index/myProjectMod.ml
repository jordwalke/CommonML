let myProjectValue =
  "this is a value from my internal utility module" ^
    Util.myUtilVal


let x = if true then Util.myUtilVal else CommonMLExampleDependency.Util.yourUtilVal

type opaquifiedYourProjectType =
    CommonMLExampleDependency.ExampleMod.yourProjectType

let reexportedYourValue:opaquifiedYourProjectType =
  CommonMLExampleDependency.ExampleMod.yourProjectValue


(* Uncomment this to verify that private non-exported modules of dependencies
   may not be relied upon. *)
(* let _ = CommonMLExampleDependency.PrivateModule.privateVal *)

let _ = CommonMLExampleDependency.Util.yourUtilVal
let _ = print_string myProjectValue

let _ = TestNestedModuleName.NestedSubmodule.NestedSubmodule.nestedVal
