import java.io.File
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction

open class BuildTask : DefaultTask() {
    @Input
    var rootDirRel: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    private val abiMap = mapOf(
        "aarch64" to "arm64-v8a",
        "armv7" to "armeabi-v7a",
        "i686" to "x86",
        "x86_64" to "x86_64"
    )

    private val rustTargetMap = mapOf(
        "aarch64" to "aarch64-linux-android",
        "armv7" to "armv7-linux-androideabi",
        "i686" to "i686-linux-android",
        "x86_64" to "x86_64-linux-android"
    )

    @TaskAction
    fun assemble() {
        val targetName = target ?: throw GradleException("target cannot be null")
        val isRelease = release ?: throw GradleException("release cannot be null")

        val soFile = getTargetSoFile(targetName, isRelease)
        if (soFile.exists()) {
            copyToJniLibs(soFile, targetName)
            return
        }

        val releaseSoFile = getTargetSoFile(targetName, true)
        if (releaseSoFile.exists()) {
            logger.warn("Debug .so not found, using release .so for $targetName")
            copyToJniLibs(releaseSoFile, targetName)
            return
        }

        tryBuildWithTauri(targetName, isRelease)
    }

    private fun copyToJniLibs(soFile: File, targetName: String) {
        val jniLibsDir = getJniLibsDir(targetName)
        if (!jniLibsDir.exists()) {
            jniLibsDir.mkdirs()
        }
        val destFile = File(jniLibsDir, "libapp_lib.so")
        if (destFile.exists()) {
            destFile.delete()
        }
        soFile.copyTo(destFile, overwrite = true)
        logger.lifecycle("Copied .so to $destFile")
    }

    private fun tryBuildWithTauri(targetName: String, isRelease: Boolean) {
        val executable = "npm"
        try {
            runTauriCli(executable, targetName, isRelease)
        } catch (e: Exception) {
            if (Os.isFamily(Os.FAMILY_WINDOWS)) {
                val fallbacks = listOf("$executable.exe", "$executable.cmd", "$executable.bat")
                var lastException: Exception = e
                for (fallback in fallbacks) {
                    try {
                        runTauriCli(fallback, targetName, isRelease)
                        return
                    } catch (fallbackException: Exception) {
                        lastException = fallbackException
                    }
                }
                throw lastException
            } else {
                throw e
            }
        }
    }

    private fun getTargetSoFile(targetName: String, isRelease: Boolean): File {
        val rustTarget = rustTargetMap[targetName] ?: targetName
        val buildType = if (isRelease) "release" else "debug"
        val baseDir = File(project.projectDir, rootDirRel ?: "")
        return File(baseDir, "target/$rustTarget/$buildType/libapp_lib.so")
    }

    private fun getJniLibsDir(targetName: String): File {
        val abi = abiMap[targetName] ?: targetName
        return File(project.projectDir, "src/main/jniLibs/$abi")
    }

    private fun runTauriCli(executable: String, targetName: String, isRelease: Boolean) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val args = mutableListOf("run", "--", "tauri", "android", "android-studio-script")
        if (project.logger.isEnabled(LogLevel.DEBUG)) {
            args.add("-vv")
        } else if (project.logger.isEnabled(LogLevel.INFO)) {
            args.add("-v")
        }
        if (isRelease) {
            args.add("--release")
        }
        args.addAll(listOf("--target", targetName))

        project.exec {
            workingDir(File(project.projectDir, rootDirRel))
            executable(executable)
            args(args)
        }.assertNormalExitValue()

        val soFile = getTargetSoFile(targetName, isRelease)
        if (soFile.exists()) {
            copyToJniLibs(soFile, targetName)
        }
    }
}
